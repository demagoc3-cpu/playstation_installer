using PackageFlow.Core;
namespace PackageFlow.Windows;
internal sealed partial class ServerHost {
    private string WebDataDirectory => settings.WebDataDirectory.Length>0 ? settings.WebDataDirectory : Path.Combine(HostDataDirectory,"web");
    internal string EffectiveWebDataDirectory => WebDataDirectory;
    internal LegacyDataReview MigrationReview() => LegacyDataMigration.Inspect(UserDirectory);
    internal void EnsureDataMigrationReady() {
        if(settings.LegacyMigrationRequired)throw new InvalidOperationException("Требуется подтверждённый перенос прежних данных WEB. Серверы и контейнеры не остановлены. Откройте Главную → Перенос данных.");
    }
    internal async Task ConfirmDataMigration(string path,bool allowEmpty,CancellationToken ct) {
        if(!settings.LegacyMigrationRequired)throw new InvalidOperationException("Перенос не требуется.");
        // Never adopt or stop a former container, even when its launcher key matches.
        CheckPort(settings.Port);CheckPort(settings.PayloadPort);
        Status?.Invoke("Копируем экспорт данных WEB для Windows…");
        var imported=await LegacyDataMigration.Import(path,UserDirectory,settings.GamesDirectory,allowEmpty,ct);
        var previousPath=settings.WebDataDirectory;
        settings.WebDataDirectory=imported;settings.ImportedLegacyDataFrom=Path.GetFullPath(path);settings.LegacyMigrationRequired=false;
        try {settings.Save(HostSettingsPath);}
        catch {settings.WebDataDirectory=previousPath;settings.ImportedLegacyDataFrom="";settings.LegacyMigrationRequired=true;throw;}
        Status?.Invoke("Создана отдельная копия данных для Windows. Исходный экспорт и volume сохранены. Проверьте хранилища в WEB.");
    }
}
