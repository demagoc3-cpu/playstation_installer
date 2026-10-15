using System.Drawing.Drawing2D;
using System.Reflection;

namespace PackageFlow.Windows;

internal static class GlassStyle
{
    private static readonly Lazy<Icon> brandIcon = new(() => {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PackageFlow.Assets.packageflow.ico")!;
        return new Icon(stream);
    });
    public static Icon BrandIcon() => (Icon)brandIcon.Value.Clone();
    private static readonly Lazy<Image> wallpaper = new(() => {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("PackageFlow.Assets.astro-night.png")!;
        using var source = Image.FromStream(stream); return new Bitmap(source);
    });
    public static void Paint(Control control, PaintEventArgs e, int shade = 150)
    {
        var form = control.FindForm();
        var size = form?.ClientSize ?? control.ClientSize;
        if (size.Width <= 0 || size.Height <= 0) return;
        var offset = Point.Empty;
        for (Control? current = control; current != null && current != form; current = current.Parent) offset.Offset(current.Left, current.Top);
        var scale = Math.Max(size.Width / (float)wallpaper.Value.Width, size.Height / (float)wallpaper.Value.Height);
        var width = wallpaper.Value.Width * scale; var height = wallpaper.Value.Height * scale;
        // All surfaces share the same backdrop coordinates. No captures or blur work
        // on the UI thread when a browser/installer is waiting in the background.
        var state = e.Graphics.Save(); e.Graphics.SetClip(e.ClipRectangle, CombineMode.Intersect);
        e.Graphics.DrawImage(wallpaper.Value, (size.Width - width) / 2 - offset.X, (size.Height - height) / 2 - offset.Y, width, height);
        using var tint = new SolidBrush(Color.FromArgb(shade, 4, 15, 35));
        e.Graphics.FillRectangle(tint, control.ClientRectangle); e.Graphics.Restore(state);
    }
    public static void TransparentLabels(Control parent)
    {
        foreach (Control child in parent.Controls) {
            if (child is Label) child.BackColor = Color.Transparent;
            TransparentLabels(child);
        }
    }
}

// Original vector pictograms: draw cleanly at every Windows DPI without fonts,
// external icon packages or emoji fallback.
internal static class LauncherIcons
{
    public static void Draw(Graphics g, int kind, Rectangle bounds, Color color)
    {
        var state = g.Save(); g.TranslateTransform(bounds.X, bounds.Y); g.ScaleTransform(bounds.Width / 24f, bounds.Height / 24f);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var p = new Pen(color, 1.65f) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        void Line(float x, float y, float x2, float y2) => g.DrawLine(p, x, y, x2, y2);
        switch (kind) {
            case 0: // Home / desktop
                g.DrawRectangle(p, 2, 3, 20, 14); Line(12,17,12,21); Line(7,21,17,21); break;
            case 1: // Controller
                using (var path = new GraphicsPath()) { path.AddBezier(6,7,2,7,0,20,5,19); path.AddLine(5,19,9,15); path.AddLine(9,15,15,15); path.AddBezier(15,15,22,24,24,13,20,8); path.AddBezier(20,8,18,5,16,7,6,7); g.DrawPath(p,path); }
                Line(6,10,6,14); Line(4,12,8,12); g.DrawEllipse(p,16,10,1.8f,1.8f); g.DrawEllipse(p,19,13,1.8f,1.8f); break;
            case 2: g.DrawEllipse(p,3,3,13,13); Line(14,14,21,21); break;
            case 3: g.DrawArc(p,3,3,18,18,40,285); Line(21,3,21,9); Line(15,9,21,9); Line(12,7,12,12); Line(12,12,16,14); break;
            case 4:
                using (var heart = new GraphicsPath()) { heart.AddBezier(12,21,-7,8,6,-3,12,6); heart.AddBezier(12,6,18,-3,31,8,12,21); g.DrawPath(p,heart); } break;
            case 5: Line(12,3,12,16); Line(7,11,12,16); Line(12,16,17,11); Line(3,17,3,21); Line(3,21,21,21); Line(21,21,21,17); break;
            case 6: g.DrawEllipse(p,8,8,8,8); for(int i=0;i<8;i++){var a=i*Math.PI/4;Line(12+(float)Math.Cos(a)*8,12+(float)Math.Sin(a)*8,12+(float)Math.Cos(a)*10,12+(float)Math.Sin(a)*10);} break;
            case 7: Line(4,12,9,17); Line(9,17,20,5); break;
            case 8: Line(5,5,19,19); Line(5,19,19,5); break;
            case 9: g.DrawArc(p,5,5,14,16,180,180); Line(5,13,4,18); Line(4,18,20,18); Line(20,18,19,13); g.DrawArc(p,10,19,4,3,0,180); break;
            case 11: // Bitcoin, original line drawing
                Line(8,4,8,20);Line(6,5,14,5);Line(6,19,14,19);g.DrawArc(p,10,5,9,7,-90,180);g.DrawArc(p,10,12,10,7,-90,180);Line(11,2,11,5);Line(15,2,15,5);Line(11,19,11,22);Line(15,19,15,22);break;
            case 12: // Tether, original line drawing
                Line(5,5,19,5);Line(12,5,12,20);g.DrawEllipse(p,3,9,18,4);break;
            case 13: // Globe
                g.DrawEllipse(p,2,2,20,20);g.DrawEllipse(p,7,2,10,20);Line(3,8,21,8);Line(3,16,21,16);break;
            case 14: // Cloud, original line drawing
                g.DrawArc(p,1,9,9,10,90,180);g.DrawArc(p,7,3,13,14,175,215);g.DrawArc(p,16,10,7,9,-100,180);Line(5,19,20,19);break;
            default: g.DrawRectangle(p,3,6,18,15); Line(3,6,3,3); Line(3,3,10,3); Line(10,3,13,6); break;
        }
        g.Restore(state);
    }
}

internal sealed class WizardHeader : BufferedPanel
{
    public int Step { get; set; }
    private readonly string language;
    private readonly Icon logo = GlassStyle.BrandIcon();
    public WizardHeader(string language) {
        this.language=language;
        var links = new BufferedFlow { Dock=DockStyle.Right, Width=230, Padding=new Padding(0,26,8,0), WrapContents=false };
        foreach(var (text,url) in new[]{("GitHub","https://github.com/demagogc3-cpu/playstation_installer"),("4PDA","https://4pda.to/forum/index.php?showtopic=1127073")}) {
            var link=new RoundedButton { Text=text, Width=80, Height=34, ForeColor=Color.White, BackColor=Theme.Navigation, Font=new Font("Segoe UI",9) };
            link.Click+=(_,_)=>ProcessRunner.Open(url); links.Controls.Add(link);
        }
        links.Controls.Add(new Label { Text=language=="en"?"EN":"RU", Width=35, Height=34, TextAlign=ContentAlignment.MiddleCenter, ForeColor=Color.FromArgb(80,215,255), BackColor=Color.Transparent });
        Controls.Add(links);
    }
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e); var g=e.Graphics; g.SmoothingMode=SmoothingMode.AntiAlias;
        g.DrawIcon(logo,new Rectangle(26,23,50,50));
        using var brand=new Font("Segoe UI",19,FontStyle.Bold);
        TextRenderer.DrawText(g,"PackageFlow",brand,new Rectangle(88,22,205,32),Color.White,TextFormatFlags.SingleLine);
        using var small=new Font("Segoe UI",8);
        TextRenderer.DrawText(g,language=="en"?"Your games. Your PlayStation.":"Удобная установка игр на PlayStation",small,new Rectangle(88,56,205,22),Theme.Muted);
        var labels=language=="en"?new[]{"Choice","Consoles","Torrents","Ready"}:new[]{"Выбор","Приставки","Торренты","Готово"};
        var start=Width>=980?350:310; var interval=Math.Max(65,Math.Min(90,(Width-start-250)/3));
        using var line=new Pen(Theme.Border,2); using var completed=new Pen(Color.FromArgb(20,190,255),2);
        for(int i=0;i<4;i++) {
            var x=start+i*interval;
            if(i<3)g.DrawLine(i<Step?completed:line,x+14,37,x+interval-14,37);
            using var brush=new SolidBrush(i<=Step?Color.FromArgb(10,155,237):Theme.Input);
            g.FillEllipse(brush,x-13,24,26,26);g.DrawEllipse(i<=Step?completed:line,x-13,24,26,26);
            if(i<Step)LauncherIcons.Draw(g,7,new Rectangle(x-8,29,16,16),Color.White);
            else TextRenderer.DrawText(g,(i+1).ToString(),Font,new Rectangle(x-12,25,25,25),Color.White,TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter);
            TextRenderer.DrawText(g,labels[i],small,new Rectangle(x-42,57,84,24),i==Step?Color.White:Theme.Muted,TextFormatFlags.HorizontalCenter);
        }
    }
    protected override void Dispose(bool disposing) { if(disposing)logo.Dispose();base.Dispose(disposing); }
}

// Hand-drawn console silhouettes and search pictograms, not stock brand art.
internal sealed class SetupArtwork : Control
{
    private readonly int kind;
    public SetupArtwork(int kind) { this.kind=kind; SetStyle(ControlStyles.SupportsTransparentBackColor|ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true); BackColor=Color.Transparent; }
    protected override void OnPaintBackground(PaintEventArgs e) => base.OnPaintBackground(e);
    protected override void OnPaint(PaintEventArgs e) {
        var g=e.Graphics; g.SmoothingMode=SmoothingMode.AntiAlias;
        var artWidth=kind is 15 or 16?170:340;var scale=Math.Min(Width/(float)artWidth,Height/150f); if(scale<=0)return;
        g.TranslateTransform((Width-artWidth*scale)/2,(Height-150*scale)/2);g.ScaleTransform(scale,scale);
        using var white=new SolidBrush(Color.FromArgb(227,237,249));using var dark=new SolidBrush(Color.FromArgb(36,46,62));using var cyan=new Pen(Color.FromArgb(80,214,255),2);
        if(kind is 1 or 15 or 16) {
            if(kind==15)g.TranslateTransform(-30,0);if(kind==16)g.TranslateTransform(-165,0);
            if(kind!=16){
            g.FillPolygon(white,new Point[] {new Point(80,20),new Point(100,8),new Point(96,120),new Point(70,120)});
            g.FillPolygon(white,new Point[] {new Point(110,8),new Point(126,23),new Point(135,120),new Point(109,120)});
            g.FillRectangle(dark,99,19,9,102);g.DrawLine(cyan,109,19,110,112);
            LauncherIcons.Draw(g,1,new Rectangle(130,94,53,45),Color.FromArgb(225,235,250));}
            if(kind!=15){
            using var black=new SolidBrush(Color.FromArgb(18,28,43)); g.FillPolygon(black,new Point[] {new Point(210,20),new Point(255,30),new Point(255,115),new Point(210,105)});
            g.FillPolygon(dark,new Point[] {new Point(255,30),new Point(269,25),new Point(269,108),new Point(255,115)});
            g.DrawLine(cyan,211,71,255,81);
            LauncherIcons.Draw(g,1,new Rectangle(268,97,48,41),Theme.Muted);}
            using var f=new Font("Segoe UI",10,FontStyle.Bold);if(kind==1){g.DrawString("PS5",f,white,82,128);g.DrawString("PS4",f,white,219,128);}
        } else {
            LauncherIcons.Draw(g,2,new Rectangle(80,19,76,76),Color.White);
            g.DrawEllipse(cyan,210,20,72,72);LauncherIcons.Draw(g,5,new Rectangle(225,34,43,43),Color.White);
            for(int i=0;i<3;i++){using var b=new SolidBrush(Color.FromArgb(45,145+i*25,220));g.FillEllipse(b,118+i*46,112,25,25);}
        }
    }
}
