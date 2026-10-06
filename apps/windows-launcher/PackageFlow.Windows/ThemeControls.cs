using System.Drawing.Drawing2D;

namespace PackageFlow.Windows;

internal static class Theme
{
    public static readonly Color Background = Color.FromArgb(19, 19, 31), Card = Color.FromArgb(30, 29, 46), Border = Color.FromArgb(57, 52, 78), Accent = Color.FromArgb(123, 96, 220), Muted = Color.FromArgb(174, 171, 196), Green = Color.FromArgb(112, 215, 166);
    public static GraphicsPath Shape(Rectangle bounds, int radius = 14)
    {
        var path = new GraphicsPath(); var d = Math.Min(radius * 2, Math.Min(bounds.Width, bounds.Height));
        if (d <= 0) return path;
        path.AddArc(bounds.X, bounds.Y, d, d, 180, 90); path.AddArc(bounds.Right - d, bounds.Y, d, d, 270, 90);
        path.AddArc(bounds.Right - d, bounds.Bottom - d, d, d, 0, 90); path.AddArc(bounds.X, bounds.Bottom - d, d, d, 90, 90); path.CloseFigure(); return path;
    }
    public static void Icon(Graphics g, int kind, Rectangle r, Color color)
    {
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using var pen = new Pen(color, 2) { StartCap = LineCap.Round, EndCap = LineCap.Round, LineJoin = LineJoin.Round };
        var x = r.X; var y = r.Y; var w = r.Width; var h = r.Height;
        switch (kind)
        {
            case 0: g.DrawRectangle(pen, x + 1, y + 2, w - 2, h - 8); g.DrawLine(pen, x + w / 2, y + h - 6, x + w / 2, y + h - 1); g.DrawLine(pen, x + 5, y + h - 1, x + w - 5, y + h - 1); break;
            case 1: g.DrawArc(pen, x, y + 3, w - 1, h - 6, 150, 240); g.DrawLine(pen, x + 4, y + h / 2, x + 10, y + h / 2); g.DrawLine(pen, x + 7, y + h / 2 - 3, x + 7, y + h / 2 + 3); g.DrawEllipse(pen, x + w - 8, y + h / 2 - 1, 2, 2); break;
            case 2: g.DrawEllipse(pen, x + 1, y + 1, w - 8, h - 8); g.DrawLine(pen, x + w - 8, y + h - 8, x + w - 1, y + h - 1); break;
            case 3: g.DrawLine(pen, x + w / 2, y + 1, x + w / 2, y + h - 8); g.DrawLines(pen, new Point[] {new(x + 5, y + h - 13), new(x + w / 2, y + h - 7), new(x + w - 5, y + h - 13) }); g.DrawLines(pen, new Point[] {new(x + 2, y + h - 7), new(x + 2, y + h - 1), new(x + w - 2, y + h - 1), new(x + w - 2, y + h - 7) }); break;
            default: g.DrawArc(pen, x + 1, y + 1, w - 2, h - 2, 35, 285); g.DrawLines(pen, new Point[] {new(x + w - 1, y + 1), new(x + w - 1, y + 8), new(x + w - 8, y + 8) }); break;
        }
    }
}

internal class RoundedPanel : Panel
{
    public RoundedPanel() { DoubleBuffered = true; BackColor = Theme.Card; }
    protected override void OnPaintBackground(PaintEventArgs e)
    {
        e.Graphics.Clear(Parent?.BackColor ?? Theme.Background);
        e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = Theme.Shape(new Rectangle(0, 0, Width - 1, Height - 1));
        using var fill = new SolidBrush(BackColor); using var border = new Pen(Theme.Border);
        e.Graphics.FillPath(fill, path); e.Graphics.DrawPath(border, path);
    }
}

internal class RoundedButton : Button
{
    public int? Glyph { get; init; }
    public bool WrapText { get; init; }
    private bool hover;
    public RoundedButton() { FlatStyle = FlatStyle.Flat; FlatAppearance.BorderSize = 0; DoubleBuffered = true; Cursor = Cursors.Hand; }
    protected override void OnMouseEnter(EventArgs e) { hover = true; Invalidate(); base.OnMouseEnter(e); }
    protected override void OnMouseLeave(EventArgs e) { hover = false; Invalidate(); base.OnMouseLeave(e); }
    protected override void OnPaint(PaintEventArgs e)
    {
        var g = e.Graphics; g.Clear(Parent?.BackColor ?? Theme.Background); g.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = Theme.Shape(new Rectangle(1, 1, Width - 3, Height - 3), 11);
        var color = Enabled ? (hover ? ControlPaint.Light(BackColor, .12f) : BackColor) : Theme.Card;
        using var fill = new SolidBrush(color); using var border = new Pen(Focused ? Color.FromArgb(186, 160, 255) : Theme.Border);
        g.FillPath(fill, path); g.DrawPath(border, path);
        var text = new Rectangle(Padding.Left, 0, Width - Padding.Horizontal, Height);
        if (Glyph is int icon) { Theme.Icon(g, icon, new Rectangle(16, (Height - 22) / 2, 22, 22), Enabled ? Theme.Muted : Color.Gray); text.X = 52; text.Width = Width - 60; }
        TextRenderer.DrawText(g, Text, Font, text, Enabled ? ForeColor : Theme.Muted,
            TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis | (WrapText ? TextFormatFlags.WordBreak : TextFormatFlags.SingleLine) | (TextAlign == ContentAlignment.MiddleLeft ? TextFormatFlags.Left : TextFormatFlags.HorizontalCenter));
    }
}

internal sealed class LogoButton : RoundedButton
{
    public Image Logo { get; init; } = null!;
    protected override void OnPaint(PaintEventArgs e) {
        base.OnPaint(e);
        var scale = Math.Min((Width - 16f) / Logo.Width, (Height - 10f) / Logo.Height);
        var size = new SizeF(Logo.Width * scale, Logo.Height * scale);
        e.Graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
        e.Graphics.DrawImage(Logo, (Width - size.Width) / 2, (Height - size.Height) / 2, size.Width, size.Height);
    }
    protected override void Dispose(bool disposing) { if (disposing) Logo.Dispose(); base.Dispose(disposing); }
}

// Pages are ordinary panels: no native TabControl frame or white theme borders.
internal sealed class PageHost : Panel
{
    private int selected;
    public ControlCollection TabPages => Controls;
    public event EventHandler? SelectedIndexChanged;
    public int SelectedIndex { get => selected; set { selected = Math.Clamp(value, 0, Math.Max(0, Controls.Count - 1)); for (var i = 0; i < Controls.Count; i++) Controls[i].Visible = i == selected; SelectedIndexChanged?.Invoke(this, EventArgs.Empty); } }
    protected override void OnControlAdded(ControlEventArgs e) { base.OnControlAdded(e); e.Control!.Visible = Controls.GetChildIndex(e.Control) == selected; }
}

internal sealed class StatusCard : RoundedPanel
{
    private readonly Label detail, state;
    public StatusCard(string title)
    {
        Padding = new Padding(14, 9, 14, 9);
        Controls.Add(new Label { Text = title, Dock = DockStyle.Top, Height = 23, Font = new Font("Segoe UI", 10, FontStyle.Bold), BackColor = BackColor });
        detail = new Label { Dock = DockStyle.Bottom, Height = 20, ForeColor = Theme.Muted, AutoEllipsis = true, BackColor = BackColor };
        state = new Label { Dock = DockStyle.Bottom, Height = 25, BackColor = BackColor };
        Controls.Add(state); Controls.Add(detail);
    }
    public void Set(string text, string note, Color color) { state.Text = "●  " + text; state.ForeColor = color; detail.Text = note; }
}

internal sealed class ActivityProgress : Control
{
    public int Value { get; set; } = -1;
    public ActivityProgress() { DoubleBuffered = true; Height = 5; }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Theme.Border); if (Value < 0) return;
        using var brush = new SolidBrush(Theme.Accent); e.Graphics.FillRectangle(brush, 0, 0, Width * Math.Clamp(Value, 0, 100) / 100, Height);
    }
}

internal sealed class DarkChoice : Control
{
    public List<object> Items { get; } = [];
    private int selected = -1;
    private readonly ContextMenuStrip menu = new();
    public event EventHandler? SelectedIndexChanged;
    public int SelectedIndex { get => selected; set { if (selected == value) return; selected = value; Invalidate(); SelectedIndexChanged?.Invoke(this, EventArgs.Empty); } }
    public object? SelectedItem => selected >= 0 && selected < Items.Count ? Items[selected] : null;
    public DarkChoice() {
        DoubleBuffered = true; TabStop = true; Height = 29; Cursor = Cursors.Hand; AccessibleRole = AccessibleRole.ComboBox;
        menu.BackColor = Theme.Card; menu.ShowImageMargin = false;
        menu.Renderer = new ToolStripProfessionalRenderer(new DarkMenuColors());
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(Parent?.BackColor ?? Theme.Background); e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
        using var path = Theme.Shape(new Rectangle(0, 0, Width - 1, Height - 1), 7);
        using var fill = new SolidBrush(BackColor); using var pen = new Pen(Focused ? Theme.Accent : Theme.Border);
        e.Graphics.FillPath(fill, path); e.Graphics.DrawPath(pen, path);
        TextRenderer.DrawText(e.Graphics, SelectedItem?.ToString() ?? "", Font, new Rectangle(10, 0, Width - 36, Height), ForeColor, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
        using var arrow = new Pen(Theme.Muted, 2);
        e.Graphics.DrawLines(arrow, new Point[] { new(Width - 20, Height / 2 - 2), new(Width - 15, Height / 2 + 3), new(Width - 10, Height / 2 - 2) });
    }
    protected override void OnClick(EventArgs e)
    {
        base.OnClick(e); Focus(); if (Items.Count == 0) return;
        if (menu.Visible) { menu.Close(); return; }
        foreach (ToolStripItem item in menu.Items.Cast<ToolStripItem>().ToArray()) { menu.Items.Remove(item); item.Dispose(); }
        menu.ForeColor = ForeColor; menu.MinimumSize = new Size(Width, 0);
        for (var i = 0; i < Items.Count; i++) {
            var index = i;
            menu.Items.Add(Items[i].ToString(), null, (_, _) => {
                // Selection can rebuild the form (language). Finish ToolStrip's close
                // dispatch before changing or disposing the owning controls.
                menu.Close();
                if (!IsDisposed && IsHandleCreated) BeginInvoke(() => { if (!IsDisposed) SelectedIndex = index; });
            });
        }
        menu.Show(this, new Point(0, Height));
    }
    protected override void OnKeyDown(KeyEventArgs e)
    {
        base.OnKeyDown(e);
        if (e.KeyCode is Keys.Space or Keys.Enter || (e.Alt && e.KeyCode == Keys.Down)) { OnClick(EventArgs.Empty); e.Handled = true; }
        else if (e.KeyCode is Keys.Down or Keys.Up && Items.Count > 0) { SelectedIndex = Math.Clamp(selected + (e.KeyCode == Keys.Down ? 1 : -1), 0, Items.Count - 1); e.Handled = true; }
    }
    protected override void Dispose(bool disposing) { if (disposing) menu.Dispose(); base.Dispose(disposing); }
    private sealed class DarkMenuColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Theme.Card;
        public override Color ImageMarginGradientBegin => Theme.Card;
        public override Color ImageMarginGradientMiddle => Theme.Card;
        public override Color ImageMarginGradientEnd => Theme.Card;
        public override Color MenuBorder => Theme.Border;
        public override Color MenuItemBorder => Theme.Accent;
        public override Color MenuItemSelected => Theme.Accent;
    }
}

internal sealed class EventHistory : Control
{
    public List<string> Items { get; } = [];
    private int offset;
    public EventHistory() { DoubleBuffered = true; TabStop = true; AccessibleRole = AccessibleRole.List; }
    public void ResetView() { offset = 0; Invalidate(); }
    private int Rows => Math.Max(1, Height / Math.Max(1, Font.Height));
    private void ScrollTo(int value) { offset = Math.Clamp(value, 0, Math.Max(0, Items.Count - Rows)); Invalidate(); }
    protected override void OnMouseWheel(MouseEventArgs e) { base.OnMouseWheel(e); ScrollTo(offset - Math.Sign(e.Delta) * 3); }
    protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); Focus(); if (e.X >= Width - 14) ScrollTo((int)((double)e.Y / Math.Max(1, Height) * (Items.Count - Rows))); }
    protected override void OnKeyDown(KeyEventArgs e) { base.OnKeyDown(e); if (e.KeyCode is Keys.Up or Keys.Down or Keys.PageUp or Keys.PageDown) { ScrollTo(offset + (e.KeyCode is Keys.Up or Keys.PageUp ? -1 : 1) * (e.KeyCode is Keys.PageUp or Keys.PageDown ? Rows : 1)); e.Handled = true; } }
    protected override void OnPaint(PaintEventArgs e)
    {
        e.Graphics.Clear(BackColor);
        for (var row = 0; row < Rows && offset + row < Items.Count; row++) TextRenderer.DrawText(e.Graphics, Items[offset + row], Font, new Rectangle(0, row * Font.Height, Width - 16, Font.Height), ForeColor, TextFormatFlags.Left | TextFormatFlags.EndEllipsis);
        if (Items.Count <= Rows) return;
        using var track = new SolidBrush(Theme.Border); using var thumb = new SolidBrush(Theme.Muted);
        var size = Math.Max(10, Height * Rows / Items.Count); var y = offset * (Height - size) / Math.Max(1, Items.Count - Rows);
        e.Graphics.FillRectangle(track, Width - 7, 0, 4, Height); e.Graphics.FillRectangle(thumb, Width - 7, y, 4, size);
    }
}

// Flow layout keeps its wrapping behavior; scrolling is painted in the app theme.
internal sealed class CardFlow : FlowLayoutPanel
{
    private int offset, contentHeight;
    private bool dragging;
    public new bool AutoScroll { get => false; set => base.AutoScroll = false; }
    public CardFlow() { DoubleBuffered = true; base.AutoScroll = false; }
    public override Rectangle DisplayRectangle => new(Padding.Left, Padding.Top - offset,
        Math.Max(1, ClientSize.Width - Padding.Horizontal - 14), Math.Max(ClientSize.Height, contentHeight));
    protected override void OnLayout(LayoutEventArgs e)
    {
        base.OnLayout(e);
        contentHeight = Controls.Cast<Control>().Select(c => c.Bottom + offset + c.Margin.Bottom + Padding.Bottom).DefaultIfEmpty(0).Max();
        var corrected = Math.Clamp(offset, 0, Math.Max(0, contentHeight - ClientSize.Height));
        if (corrected != offset) { offset = corrected; base.OnLayout(e); }
        Invalidate();
    }
    private void ScrollTo(int value) { offset = Math.Clamp(value, 0, Math.Max(0, contentHeight - ClientSize.Height)); PerformLayout(); Invalidate(); }
    protected override void OnMouseWheel(MouseEventArgs e) { ScrollTo(offset - Math.Sign(e.Delta) * 56); }
    protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); if (e.X >= Width - 14) { dragging = true; Capture = true; Drag(e.Y); } }
    protected override void OnMouseMove(MouseEventArgs e) { base.OnMouseMove(e); if (dragging) Drag(e.Y); }
    protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); dragging = false; Capture = false; }
    private void Drag(int y) => ScrollTo((int)((double)y / Math.Max(1, Height) * Math.Max(0, contentHeight - Height)));
    protected override void OnControlAdded(ControlEventArgs e) { base.OnControlAdded(e); if (e.Control != null) WatchFocus(e.Control); }
    private void WatchFocus(Control control)
    {
        control.Enter += (_, _) => {
            var card = control; while (card.Parent != null && card.Parent != this) card = card.Parent;
            if (card.Parent != this) return;
            if (card.Top < 0) ScrollTo(offset + card.Top - 6);
            else if (card.Bottom > ClientSize.Height) ScrollTo(offset + card.Bottom - ClientSize.Height + 6);
        };
        control.ControlAdded += (_, e) => { if (e.Control != null) WatchFocus(e.Control); };
        foreach (Control child in control.Controls) WatchFocus(child);
    }
    protected override void OnPaint(PaintEventArgs e)
    {
        base.OnPaint(e); if (contentHeight <= Height) return;
        var size = Math.Max(20, Height * Height / contentHeight);
        var y = offset * (Height - size) / Math.Max(1, contentHeight - Height);
        using var track = new SolidBrush(Theme.Border); using var thumb = new SolidBrush(Theme.Muted);
        e.Graphics.FillRectangle(track, Width - 7, 0, 4, Height); e.Graphics.FillRectangle(thumb, Width - 7, y, 4, size);
    }
}
