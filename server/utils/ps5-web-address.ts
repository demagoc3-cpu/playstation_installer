import { serviceWebAddress } from './service-web-address';

/** Same LAN address chosen for PS4, plus the profile required by catalog/v2. */
export function ps5WebAddressHeaders(url: string, consoleId: string) {
  const parsed = new URL(url);
  if (
    serviceWebAddress(parsed.hostname, parsed.port || 80) !== url ||
    !/^[A-Za-z0-9_-]{1,64}$/.test(consoleId)
  )
    throw new Error('Invalid PS5 WEB configuration');
  return {
    'X-PackageFlow-Web-Host': parsed.hostname,
    'X-PackageFlow-Web-Port': parsed.port || '80',
    'X-PackageFlow-Console-Id': consoleId,
  };
}
export function ps5WebAddressAccepted(body: any, headers: ReturnType<typeof ps5WebAddressHeaders>) {
  return (
    body?.service === 'PackageFlowService-PS5' &&
    body.webConfigured === true &&
    body.webHost === headers['X-PackageFlow-Web-Host'] &&
    body.webPort === Number(headers['X-PackageFlow-Web-Port']) &&
    body.webConsoleId === headers['X-PackageFlow-Console-Id']
  );
}
