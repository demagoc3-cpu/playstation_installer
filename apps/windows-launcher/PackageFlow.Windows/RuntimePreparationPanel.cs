using PackageFlow.Core;
namespace PackageFlow.Windows;
internal sealed class RuntimePreparationPanel : UserControl
{
    private readonly Label status=new(){Dock=DockStyle.Top,Height=70,ForeColor=Color.White,Font=new Font("Segoe UI",13)};
    private readonly TextBox details=new(){Dock=DockStyle.Fill,Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,BackColor=Color.FromArgb(10,28,48),ForeColor=Color.White,BorderStyle=BorderStyle.None};
    private readonly ProgressBar progress=new(){Dock=DockStyle.Top,Height=12,Style=ProgressBarStyle.Marquee};
    private readonly Button retry=new(){Text="Повторить",AutoSize=true,Enabled=false};
    private readonly Button close=new(){Text="Закрыть",AutoSize=true};
    private TaskCompletionSource<bool>? answer;
    public RuntimePreparationPanel() {
        Dock=DockStyle.Fill;BackColor=Color.FromArgb(3,13,31);Padding=new Padding(35);Font=new Font("Segoe UI",11);
        var title=new Label {Text="Подготовка интерфейса PackageFlow",Dock=DockStyle.Top,Height=65,ForeColor=Color.White,Font=new Font("Segoe UI",22,FontStyle.Bold)};
        var buttons=new FlowLayoutPanel {Dock=DockStyle.Bottom,Height=55,FlowDirection=FlowDirection.RightToLeft};buttons.Controls.Add(close);buttons.Controls.Add(retry);
        var link=new LinkLabel {Text="Microsoft WebView2 — официальный сайт / ручная установка",Dock=DockStyle.Bottom,Height=40,LinkColor=Color.LightSkyBlue};link.LinkClicked+=(_,_)=>ProcessRunner.Open("https://developer.microsoft.com/en-us/microsoft-edge/webview2/");
        Controls.Add(details);Controls.Add(link);Controls.Add(buttons);Controls.Add(progress);Controls.Add(status);Controls.Add(title);
        retry.Click+=(_,_)=>answer?.TrySetResult(true);close.Click+=(_,_)=>answer?.TrySetResult(false);
    }
    public void ShowProgress(RuntimeProgress value) {
        if(IsDisposed)return;status.Text=value.Message;retry.Enabled=false;
        progress.Style=value.Percent.HasValue?ProgressBarStyle.Continuous:ProgressBarStyle.Marquee;
        if(value.Percent.HasValue)progress.Value=Math.Clamp(value.Percent.Value,0,100);
        details.Text="Интерфейс работает с локальными файлами. Интернет нужен только для установки отсутствующего Microsoft WebView2 Runtime. Runtime не связан с торрентами или FlareSolverr.\r\n\r\nMicrosoft Setup запускается без повышения прав; результат зависит от политик Windows.\r\n\r\n"+value.Stage;
    }
    public async Task<bool> ShowError(Exception error,CancellationToken ct) {
        status.Text="Интерфейс пока не готов";progress.Style=ProgressBarStyle.Continuous;progress.Value=0;
        details.Text=error.Message+"\r\n\r\nЗакройте это окно или повторите проверку вручную. Общий Runtime Microsoft не удаляется.";
        retry.Text=error is RuntimePreparationException {Uncertain:true}?"Проверить снова":"Повторить";retry.Enabled=true;
        answer=new(TaskCreationOptions.RunContinuationsAsynchronously);
        try { return await answer.Task.WaitAsync(ct); } finally {answer=null;}
    }
}
