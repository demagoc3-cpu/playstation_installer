using System.Text.Json.Nodes;
namespace PackageFlow.Windows;

internal static class SavedConsoleGrid
{
    public static DataGridView Create(string language)
    {
        string T(string ru,string en)=>language=="en"?en:ru;
        var grid=new DataGridView { Dock=DockStyle.Fill, BackgroundColor=Theme.Card, BorderStyle=BorderStyle.None,
            AllowUserToAddRows=false, AllowUserToDeleteRows=false, ReadOnly=false, MultiSelect=false,
            RowHeadersVisible=false, SelectionMode=DataGridViewSelectionMode.FullRowSelect,
            AutoSizeColumnsMode=DataGridViewAutoSizeColumnsMode.Fill, EnableHeadersVisualStyles=false,
            ColumnHeadersHeightSizeMode=DataGridViewColumnHeadersHeightSizeMode.DisableResizing, ColumnHeadersHeight=38,
            GridColor=Theme.Border, AccessibleName=T("Добавленные приставки", "Saved consoles") };
        grid.ColumnHeadersDefaultCellStyle=new() {BackColor=Theme.Card,ForeColor=Theme.Muted};
        grid.DefaultCellStyle=new() {BackColor=Theme.Card,ForeColor=Color.White,SelectionBackColor=Theme.Accent,SelectionForeColor=Color.White,Padding=new Padding(5)};
        grid.RowTemplate.Height=46;
        grid.Columns.Add(new DataGridViewCheckBoxColumn {Name="batch",HeaderText="✓",Width=36,MinimumWidth=36,AutoSizeMode=DataGridViewAutoSizeColumnMode.None});
        grid.CurrentCellDirtyStateChanged+=(_,_)=>{if(grid.IsCurrentCellDirty)grid.CommitEdit(DataGridViewDataErrorContexts.Commit);};
        foreach(var (key,title,width) in new[] {
            ("name",T("Приставка","Console"),150),("platform","PS",55),("ip","IP",115),
            ("model",T("Модель","Model"),85),("firmware","FW",70),("online",T("Связь","Connection"),110),
            ("paired",T("Сопряжение","Pairing"),110),("version",T("Служба","Service"),100),
            ("formats",T("Форматы","Formats"),130),("free",T("Свободно","Free"),100) }) {
            grid.Columns.Add(key,title);grid.Columns[key].MinimumWidth=width;grid.Columns[key].FillWeight=width;grid.Columns[key].ReadOnly=true;
        }
        return grid;
    }
    public static void Render(DataGridView grid,JsonNode list,string selectedId,string language)
    {
        string T(string ru,string en)=>language=="en"?en:ru;
        var unknown=T("Не проверено","Not checked");
        var current=grid.SelectedRows.Count>0?grid.SelectedRows[0].Tag as string:selectedId;
        var marked=CheckedIds(grid).ToHashSet();
        grid.Rows.Clear();
        foreach(var p in list["consoles"]!.AsArray()) {
            if(p==null)continue;
            var id=p["id"]!.GetValue<string>();
            var fresh=p["checkedAt"]?.GetValue<long>() is long at && DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()-at<60000;
            var online=fresh&&p["online"]?.GetValue<bool>()==true;
            var formats=online?p["capabilities"]?["formats"]?.AsArray():null;
            var bytes=online?p["freeBytes"]?.GetValue<double>():null;
            var n=grid.Rows.Add(marked.Contains(id),p["name"]?.GetValue<string>(),p["platform"]?.GetValue<string>()?.ToUpperInvariant(),
                p["ip"]?.GetValue<string>(),p["model"]?.GetValue<string>() ?? unknown,
                online?p["firmware"]?.GetValue<string>() ?? unknown:unknown,
                fresh?(online?T("В сети","Online"):T("Недоступна","Offline")):unknown,
                online?(p["paired"]?.GetValue<bool>()==true?T("Сопряжено","Paired"):T("Нет сопряжения","Not paired")):unknown,
                online?p["pkgVersion"]?.GetValue<string>() ?? p["version"]?.GetValue<string>() ?? unknown:unknown,
                formats?.Count>0?string.Join(", ",formats.Select(f=>f!.GetValue<string>().ToUpperInvariant())):unknown,
                bytes.HasValue?$"{bytes.Value/1024/1024/1024:0.0} GB":unknown);
            grid.Rows[n].Tag=id;
            grid.Rows[n].Selected=id==current;
            grid.Rows[n].Cells["formats"].ToolTipText=T("WebKit и kstuff: не проверено. Форматы подтверждает служба.","WebKit and kstuff: not checked. Formats are confirmed by the service.");
        }
    }
    public static string[] CheckedIds(DataGridView grid)=>grid.Rows.Cast<DataGridViewRow>().Where(row=>row.Cells["batch"].Value is true && row.Tag is string).Select(row=>(string)row.Tag!).ToArray();
}
