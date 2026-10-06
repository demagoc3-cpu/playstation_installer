namespace PackageFlow.Windows;

internal sealed partial class MainForm
{
    private bool repaintPending;

    private void RepaintSurface()
    {
        if (!IsHandleCreated || IsDisposed || repaintPending) return;
        repaintPending = true;
        BeginInvoke(() => {
            repaintPending = false;
            if (!IsDisposed) { Invalidate(true); Update(); }
        });
    }

    protected override void OnMove(EventArgs e) { base.OnMove(e); RepaintSurface(); }
    protected override void OnResize(EventArgs e) { base.OnResize(e); RepaintSurface(); }
    protected override void OnResizeEnd(EventArgs e) { base.OnResizeEnd(e); RepaintSurface(); }
}
