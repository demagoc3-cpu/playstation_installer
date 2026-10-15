import { spawn, type ChildProcess } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rm,
  rmdir,
  stat,
  lstat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve, win32 } from 'node:path';
import { createError } from 'h3';
import { dataPath } from './data-path';
import type { StorageKind } from '../../shared/types/storage';

export interface MountSource {
  id: string;
  kind: StorageKind;
  path: string;
  localPath: string;
  username: string;
  domain: string;
}
export interface StorageConnector {
  connect(source: MountSource, password: string): Promise<void>;
  disconnect(source: MountSource): Promise<void>;
  close(): void;
}
const fail = (message: string) => createError({ statusCode: 503, message });
export function normalizeStoragePath(
  kind: StorageKind,
  input: string,
  platform = process.platform,
) {
  const path = input.trim();
  if (!path || path.length > 2048 || /[\x00-\x1f\x7f]/.test(path))
    throw createError({ statusCode: 400, message: 'Укажите корректный путь хранилища' });
  if (kind === 'local') {
    if (!(platform === 'win32' ? win32.isAbsolute(path) : isAbsolute(path)))
      throw createError({ statusCode: 400, message: 'Укажите полный путь к локальной папке' });
    return platform === 'win32' ? win32.resolve(path) : resolve(path);
  }
  if (kind === 'webdav') {
    let url: URL;
    try {
      url = new URL(path);
    } catch {
      throw createError({
        statusCode: 400,
        message: 'Укажите адрес WebDAV, например https://nas:5006/games/',
      });
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.hash ||
      url.search
    )
      throw createError({
        statusCode: 400,
        message: 'Логин и пароль указываются отдельно от адреса WebDAV',
      });
    return url.href.replace(/\/+$/, '') + '/';
  }
  const value =
    kind === 'smb'
      ? path.replace(/^smb:\/\//i, '//').replace(/\\/g, '/')
      : path.replace(/^nfs:\/\//i, '');
  const match =
    kind === 'smb'
      ? /^\/\/([a-z0-9][a-z0-9.-]*)(\/[^/]+)(\/.*)?$/i.exec(value)
      : /^([a-z0-9][a-z0-9.-]*):?(\/.*)$/i.exec(value);
  if (!match)
    throw createError({
      statusCode: 400,
      message:
        kind === 'smb'
          ? 'Укажите SMB путь: smb://NAS/games'
          : 'Укажите NFS путь: NAS:/volume1/games',
    });
  const tail = match.slice(2).filter(Boolean).join('').replace(/\/+$/, '') || '/';
  if (tail.split('/').some((part) => part === '..' || part === '.') || /[,:@?*"<>|]/.test(tail))
    throw createError({ statusCode: 400, message: 'Недопустимый путь сетевого хранилища' });
  return kind === 'smb'
    ? `//${match[1]!.toLowerCase()}${tail}`
    : `${match[1]!.toLowerCase()}:${tail}`;
}
export function mountedStoragePath(
  id: string,
  kind: StorageKind,
  path: string,
  platform = process.platform,
) {
  if (kind === 'local') return path;
  if (platform === 'win32' && kind === 'smb') return path.replace(/\//g, '\\');
  if (platform === 'win32' && kind === 'nfs')
    return `\\\\nfs\\${path.replace(':/', '/').replace(/\//g, '\\')}`;
  return dataPath('storage-mounts', id);
}
function run(
  file: string,
  args: string[],
  input?: string,
  env?: NodeJS.ProcessEnv,
): Promise<string> {
  return new Promise((done, reject) => {
    const child = spawn(file, args, {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env || process.env,
    });
    let output = '',
      overflow = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(fail('Подключение хранилища превысило время ожидания'));
    }, 20000);
    child.stdout.on('data', (bytes) => {
      output += bytes.toString('utf8');
      if (output.length > 65536) {
        overflow = true;
        child.kill();
      }
    });
    // Native tools can echo credentials on failure. Never return their stderr.
    child.stderr.resume();
    child.on('error', (e: any) => {
      clearTimeout(timer);
      reject(
        fail(
          e.code === 'ENOENT'
            ? 'Компонент подключения не установлен на компьютере WEB'
            : 'Не удалось запустить подключение хранилища',
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      code === 0 && !overflow
        ? done(output.trim())
        : reject(
            fail(
              'Не удалось подключить хранилище. Проверьте доступ, права и компоненты подключения',
            ),
          );
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input || '');
  });
}
export function withStorageTimeout<T>(promise: Promise<T>, ms = 15000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(fail('Хранилище не отвечает')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
async function readable(path: string) {
  if (!(await stat(path)).isDirectory()) throw fail('Хранилище не является папкой');
  await readdir(path);
}
async function linuxMount(path: string) {
  const entries = (await readFile('/proc/mounts', 'utf8'))
    .split('\n')
    .map((line) => line.split(' '));
  return entries.find((item) => item[1]?.replace(/\\040/g, ' ').replace(/\\134/g, '\\') === path);
}
// Fixed program; all user input and passwords arrive on stdin, never as code.
const WINDOWS_CONNECT = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=New-Object Text.UTF8Encoding($false); $d=[Console]::In.ReadToEnd()|ConvertFrom-Json
Add-Type @'
using System; using System.Runtime.InteropServices;
public class PFStorageNetwork {
 [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct Resource { public int scope,type,display,usage; public string local,remote,comment,provider; }
 [DllImport("mpr.dll", CharSet=CharSet.Unicode)] public static extern int WNetAddConnection2(ref Resource r,string password,string user,int flags);
}
'@
$r=New-Object PFStorageNetwork+Resource; $r.type=1; $r.remote=$d.remote
$rc=[PFStorageNetwork]::WNetAddConnection2([ref]$r,$d.password,$d.user,0)
if($rc -ne 0){ if($rc -eq 1219){[Console]::Out.Write('credential-conflict')}else{[Console]::Out.Write('failed:'+ $rc)}; exit 1 }
[Console]::Out.Write('connected')`;

// GIO answers authentication through signals; credentials are JSON on stdin.
// GVfs provides SMB paths to a desktop Linux user without privileged CIFS mounts.
const LINUX_SMB_GIO = `import json,os,sys
from urllib.parse import quote
from gi.repository import Gio,GLib
d=json.load(sys.stdin)
host,share,*tail=d['path'][2:].split('/')
os.environ.setdefault('DBUS_SESSION_BUS_ADDRESS','unix:path=/run/user/'+str(os.getuid())+'/bus')
uri='smb://'+(quote(d['username'],safe='')+'@' if d['username'] else '')+host+'/'+quote(share,safe='')+'/'+('/'.join(quote(p,safe='') for p in tail))
f=Gio.File.new_for_uri(uri);op=Gio.MountOperation();loop=GLib.MainLoop();cancel=Gio.Cancellable();result={}
def ask(op,message,user,domain,flags):
 op.set_username(d['username']);op.set_password(d['password']);op.set_domain(d['domain'] or domain or 'WORKGROUP');op.set_password_save(Gio.PasswordSave.NEVER);op.reply(Gio.MountOperationResult.HANDLED)
def finish(f,response,*args):
 try:f.mount_enclosing_volume_finish(response)
 except GLib.Error as e:
  if not e.matches(Gio.io_error_quark(),Gio.IOErrorEnum.ALREADY_MOUNTED):result['failed']=True
 loop.quit()
def timeout():
 result['failed']=True;cancel.cancel();loop.quit();return False
op.connect('ask-password',ask)
f.mount_enclosing_volume(Gio.MountMountFlags.NONE,op,cancel,finish,None)
GLib.timeout_add_seconds(12,timeout);loop.run()
path=f.get_path()
if result.get('failed') or not path:sys.exit(1)
print(json.dumps({'path':path}))`;

export function createStorageConnector(
  options: { linuxSmb?: 'auto' | 'cifs' } = {},
): StorageConnector {
  const children = new Map<string, ChildProcess>();
  return {
    async connect(source, password) {
      if (source.kind === 'local') {
        await withStorageTimeout(readable(source.path));
        return;
      }
      if (source.kind === 'webdav') {
        if (!children.has(source.id)) {
          const binary =
            process.env.PACKAGEFLOW_RCLONE ||
            (process.platform === 'win32' ? 'rclone.exe' : 'rclone');
          let obscured: string;
          try {
            obscured = password ? await run(binary, ['obscure', '-'], password) : '';
          } catch {
            throw fail(
              'Для WebDAV установите rclone и WinFsp (Windows) или FUSE (Linux) на компьютере WEB',
            );
          }
          await mkdir(dirname(source.localPath), { recursive: true });
          if (process.platform !== 'win32') {
            const mount = await linuxMount(source.localPath);
            if (mount) {
              if (mount[0] !== `packageflow-${source.id}`)
                throw fail('Точка подключения занята другим хранилищем');
              await withStorageTimeout(readable(source.localPath));
              return;
            }
            await mkdir(source.localPath, { recursive: true });
            if ((await readdir(source.localPath)).length) throw fail('Точка подключения не пуста');
          } else if (await stat(source.localPath).catch(() => null)) {
            // A failed WinFsp mount can leave its empty directory behind.
            // rmdir is non-recursive and refuses live or non-empty sources.
            try {
              await rmdir(source.localPath);
            } catch {
              throw fail('Точка WebDAV уже занята. Проверьте прежнее подключение');
            }
          }
          const child = spawn(
            binary,
            [
              'mount',
              'pf:',
              source.localPath,
              '--config',
              process.platform === 'win32' ? 'NUL' : '/dev/null',
              '--read-only',
              '--vfs-cache-mode',
              'off',
              '--buffer-size',
              '8M',
              '--dir-cache-time',
              '10s',
              '--attr-timeout',
              '1s',
              '--devname',
              `packageflow-${source.id}`,
              '--file-perms',
              '0600',
              '--dir-perms',
              '0700',
            ],
            {
              windowsHide: true,
              stdio: ['ignore', 'ignore', 'pipe'],
              env: {
                ...process.env,
                RCLONE_CONFIG_PF_TYPE: 'webdav',
                RCLONE_CONFIG_PF_URL: source.path,
                RCLONE_CONFIG_PF_VENDOR: 'other',
                RCLONE_CONFIG_PF_USER: source.username,
                RCLONE_CONFIG_PF_PASS: obscured,
              },
            },
          );
          child.stderr?.resume();
          children.set(source.id, child);
          let ended = false;
          child.on('error', () => {
            ended = true;
            children.delete(source.id);
          });
          child.on('close', () => {
            ended = true;
            children.delete(source.id);
          });
          const until = Date.now() + 15000;
          let mounted = false;
          while (!ended && Date.now() < until) {
            await new Promise((done) => setTimeout(done, 250));
            mounted =
              process.platform === 'win32'
                ? Boolean(await stat(source.localPath).catch(() => null))
                : Boolean(await linuxMount(source.localPath));
            if (mounted) break;
          }
          if (!mounted || ended) {
            child.kill();
            throw fail('WebDAV не подключён. Проверьте URL, доступ и rclone / WinFsp / FUSE');
          }
        }
        await withStorageTimeout(readable(source.localPath));
        return;
      }
      if (process.platform === 'win32') {
        if (!source.username && !password) {
          try {
            await withStorageTimeout(readable(source.localPath));
            return;
          } catch {}
        }
        const remote =
          source.kind === 'smb'
            ? source.path.split('/').slice(0, 4).join('/').replace(/\//g, '\\')
            : source.localPath;
        try {
          await run(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_CONNECT],
            JSON.stringify({
              remote,
              user: source.domain
                ? `${source.domain}\\${source.username}`
                : source.username || null,
              password: password || null,
            }),
          );
        } catch {
          throw fail(
            source.kind === 'nfs'
              ? 'Для NFS установите NFS-Win и WinFsp; разрешите компьютеру WEB доступ к NFS на NAS'
              : 'SMB не подключён. Проверьте пароль и существующие подключения Windows к этому NAS',
          );
        }
        await withStorageTimeout(readable(source.localPath));
        return;
      }
      if (process.platform !== 'linux')
        throw fail(
          'На этой системе используйте уже подключённую сетевую папку как локальное хранилище',
        );
      if (source.kind === 'smb' && process.getuid?.() !== 0 && options.linuxSmb !== 'cifs') {
        try {
          const result = JSON.parse(
            await run(
              '/usr/bin/python3',
              ['-c', LINUX_SMB_GIO],
              JSON.stringify({
                path: source.path,
                username: source.username,
                domain: source.domain,
                password,
              }),
            ),
          );
          const prefix = `/run/user/${process.getuid?.()}/gvfs/`;
          if (typeof result.path !== 'string' || !result.path.startsWith(prefix))
            throw fail('Нет локального пути SMB. Проверьте gvfs-fuse');
          await mkdir(dirname(source.localPath), { recursive: true });
          const point = await lstat(source.localPath).catch(() => null);
          if (point?.isSymbolicLink()) {
            const target = await readlink(source.localPath);
            if (!target.startsWith(prefix))
              throw fail('Точка подключения принадлежит другому хранилищу');
            if (target !== result.path) {
              await unlink(source.localPath);
              await symlink(result.path, source.localPath);
            }
          } else {
            if (point) await rmdir(source.localPath); // refuses non-empty directories
            await symlink(result.path, source.localPath);
          }
          await withStorageTimeout(readable(source.localPath));
          return;
        } catch {
          // A headless server can instead have explicitly granted CIFS mount
          // permission. Never request sudo or an interactive password prompt.
          if ((await lstat(source.localPath).catch(() => null))?.isSymbolicLink())
            throw fail(
              'SMB недоступен. Проверьте пароль, путь и пользовательское подключение Linux',
            );
        }
      }
      await mkdir(source.localPath, { recursive: true });
      const mount = await linuxMount(source.localPath);
      if (mount) {
        const remote =
          source.kind === 'smb' ? source.path.split('/').slice(0, 4).join('/') : source.path;
        if (
          mount[0] !== remote ||
          !(source.kind === 'smb' ? mount[2] === 'cifs' : mount[2]?.startsWith('nfs'))
        )
          throw fail('Точка подключения занята другим хранилищем');
      } else {
        if ((await readdir(source.localPath)).length) throw fail('Точка подключения не пуста');
        const authDir = await mkdtemp(dataPath('storage-auth-'));
        try {
          if (source.kind === 'smb') {
            const cred = join(authDir, 'credentials');
            await writeFile(
              cred,
              `username=${source.username}\npassword=${password}\ndomain=${source.domain}\n`,
              { mode: 0o600 },
            );
            const parts = source.path.split('/'),
              remote = parts.slice(0, 4).join('/'),
              sub = parts.slice(4).join('/');
            await run('/usr/sbin/mount.cifs', [
              remote,
              source.localPath,
              '-o',
              `ro,nosuid,nodev,iocharset=utf8,credentials=${cred},uid=${process.getuid?.() || 0},gid=${process.getgid?.() || 0}${sub ? `,prefixpath=${sub}` : ''}${!source.username && !password ? ',guest' : ''}`,
            ]);
          } else
            await run('/usr/sbin/mount.nfs', [
              source.path,
              source.localPath,
              '-o',
              'ro,nosuid,nodev,soft,timeo=50,retrans=2',
            ]);
        } catch {
          throw fail(
            source.kind === 'smb'
              ? 'SMB не подключён. Проверьте доступ; нужны gvfs-backends, gvfs-fuse, python3-gi либо cifs-utils с правом монтирования'
              : 'Для NFS нужны nfs-common и право монтирования у службы WEB; проверьте разрешения экспорта NAS',
          );
        } finally {
          await rm(authDir, { recursive: true, force: true });
        }
      }
      await withStorageTimeout(readable(source.localPath));
    },
    async disconnect(source) {
      const child = children.get(source.id);
      if (child) {
        const exited = new Promise<void>((done) => child.once('close', () => done()));
        child.kill();
        await withStorageTimeout(exited, 5000);
        children.delete(source.id);
        if (process.platform === 'win32') await rmdir(source.localPath).catch(() => {});
        return;
      }
      // Windows deviceless connections may also be used by Explorer/another
      // source. Do not remove those shared sessions on deletion of a record.
      if (process.platform !== 'linux' || source.kind === 'local') return;
      const point = await lstat(source.localPath).catch(() => null);
      if (source.kind === 'smb' && point?.isSymbolicLink()) {
        const target = await readlink(source.localPath);
        if (!target.startsWith(`/run/user/${process.getuid?.()}/gvfs/`))
          throw fail('Точка подключения принадлежит другому хранилищу');
        await unlink(source.localPath); // only our link; leave shared desktop sessions alone
        return;
      }
      const mount = await linuxMount(source.localPath);
      if (mount) {
        const remote =
          source.kind === 'webdav'
            ? `packageflow-${source.id}`
            : source.kind === 'smb'
              ? source.path.split('/').slice(0, 4).join('/')
              : source.path;
        if (
          mount[0] !== remote ||
          !(source.kind === 'webdav'
            ? mount[2]?.startsWith('fuse')
            : source.kind === 'smb'
              ? mount[2] === 'cifs'
              : mount[2]?.startsWith('nfs'))
        )
          throw fail('Точка подключения принадлежит другому хранилищу');
        await run(
          source.kind === 'webdav' ? 'fusermount3' : '/usr/bin/umount',
          ['-u', source.localPath].filter((arg) => source.kind === 'webdav' || arg !== '-u'),
        );
      }
    },
    close() {
      for (const child of children.values()) child.kill();
      children.clear();
    },
  };
}
