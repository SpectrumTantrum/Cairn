interface VaultPickerProps {
  vaultPath: string | null;
  ollama: { up: boolean; models: string[] };
  busy: boolean;
  onChooseVault(): void;
  onRefreshOllama(): void;
}

export function VaultPicker({
  vaultPath,
  ollama,
  busy,
  onChooseVault,
  onRefreshOllama,
}: VaultPickerProps) {
  return (
    <div className="vault-picker">
      <div className="vault-path" title={vaultPath ?? "No vault selected"}>
        {vaultPath ?? "No vault selected"}
      </div>
      <button type="button" onClick={onChooseVault} disabled={busy}>
        Choose Vault
      </button>
      <button type="button" className="secondary-button" onClick={onRefreshOllama} disabled={busy}>
        Ollama {ollama.up ? "Online" : "Offline"}
      </button>
    </div>
  );
}
