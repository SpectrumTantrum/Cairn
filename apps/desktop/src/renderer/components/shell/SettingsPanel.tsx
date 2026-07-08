import { useMemo, useState } from "react";
import { Check, Cloud, Loader2, Plus, Trash2, X } from "lucide-react";
import type {
  ProviderInput,
  ProviderMeta,
  ProviderPreset,
  TestConnectionResult,
} from "../../../shared/types.js";

interface SettingsPanelProps {
  presets: ProviderPreset[];
  providers: ProviderMeta[];
  onClose(): void;
  onChanged(): void;
}

interface Draft {
  id?: string;
  presetId: string;
  label: string;
  baseUrl: string;
  model: string;
  apiVersion: string;
  deployment: string;
  region: string;
  apiKey: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
  hasKey: boolean;
}

function draftFromPreset(preset: ProviderPreset): Draft {
  return {
    presetId: preset.id,
    label: preset.label,
    baseUrl: preset.baseUrl,
    model: "",
    apiVersion: preset.apiVersion ?? "",
    deployment: "",
    region: "",
    apiKey: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    hasKey: false,
  };
}

function draftFromExisting(meta: ProviderMeta): Draft {
  return {
    id: meta.id,
    presetId: meta.presetId ?? "custom",
    label: meta.label,
    baseUrl: meta.baseUrl,
    model: meta.model,
    apiVersion: meta.apiVersion ?? "",
    deployment: meta.deployment ?? "",
    region: meta.region ?? "",
    apiKey: "",
    accessKeyId: "",
    secretAccessKey: "",
    sessionToken: "",
    hasKey: meta.hasKey,
  };
}

/** BYOK cloud-provider settings (ADR-0002). Add/edit/delete + a token-free test probe. */
export function SettingsPanel({ presets, providers, onClose, onChanged }: SettingsPanelProps) {
  const firstPreset = presets[0];
  const [draft, setDraft] = useState<Draft | null>(null);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<TestConnectionResult | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const preset = useMemo(
    () => presets.find((p) => p.id === draft?.presetId) ?? firstPreset,
    [presets, draft?.presetId, firstPreset],
  );

  function startNew(): void {
    if (firstPreset) setDraft(draftFromPreset(firstPreset));
    setTest(null);
    setFormError(null);
  }

  function startEdit(meta: ProviderMeta): void {
    setDraft(draftFromExisting(meta));
    setTest(null);
    setFormError(null);
  }

  function selectPreset(id: string): void {
    const p = presets.find((x) => x.id === id);
    if (p) setDraft({ ...draftFromPreset(p), id: draft?.id });
    setTest(null);
  }

  function buildInput(): ProviderInput | null {
    if (!draft || !preset) return null;
    const isBedrock = preset.kind === "bedrock";
    const secret = isBedrock
      ? draft.accessKeyId || draft.secretAccessKey || draft.sessionToken
        ? {
            accessKeyId: draft.accessKeyId || undefined,
            secretAccessKey: draft.secretAccessKey || undefined,
            sessionToken: draft.sessionToken || undefined,
          }
        : undefined
      : draft.apiKey
        ? { apiKey: draft.apiKey }
        : undefined;

    return {
      id: draft.id,
      presetId: preset.id,
      label: draft.label.trim() || preset.label,
      kind: preset.kind,
      baseUrl: draft.baseUrl.trim(),
      model: draft.model.trim(),
      authHeader: preset.authHeader,
      extraHeaders: preset.extraHeaders,
      extraBody: preset.extraBody,
      apiVersion: draft.apiVersion.trim() || preset.apiVersion,
      deployment: draft.deployment.trim() || undefined,
      region: draft.region.trim() || undefined,
      secret,
    };
  }

  async function runTest(): Promise<void> {
    const input = buildInput();
    if (!input) return;
    setTesting(true);
    setTest(null);
    setFormError(null);
    try {
      setTest(await window.cairn.testProvider(input));
    } catch (err) {
      setTest({ ok: false, error: err instanceof Error ? err.message : String(err) });
    } finally {
      setTesting(false);
    }
  }

  async function save(): Promise<void> {
    const input = buildInput();
    if (!input) return;
    if (!input.baseUrl) {
      setFormError("Base URL is required.");
      return;
    }
    if (!input.model) {
      setFormError("Enter a model id.");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      await window.cairn.saveProvider(input);
      setDraft(null);
      setTest(null);
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await window.cairn.deleteProvider(id);
      if (draft?.id === id) setDraft(null);
      onChanged();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : String(err));
    }
  }

  const isBedrock = preset?.kind === "bedrock";
  const isAzure = preset?.kind === "azure-openai";

  return (
    <div className="settings-backdrop" role="dialog" aria-modal="true" aria-label="Settings">
      <div className="settings-panel">
        <div className="settings-header">
          <h2>
            <Cloud size={16} /> Cloud models (BYOK)
          </h2>
          <button type="button" className="icon-btn" title="Close settings" onClick={onClose}>
            <X size={16} />
          </button>
        </div>

        <p className="settings-intro">
          Bring your own key. Keys are encrypted on this device (safeStorage) and never leave the main
          process or touch your vault. Escalation is always an explicit, per-turn action — nothing is
          sent to a cloud provider unless you press Escalate.
        </p>

        <div className="settings-body">
          <div className="provider-list">
            {providers.length === 0 ? (
              <p className="muted">No cloud providers yet.</p>
            ) : (
              providers.map((p) => (
                <div key={p.id} className={`provider-row${draft?.id === p.id ? " editing" : ""}`}>
                  <button type="button" className="provider-row-main" onClick={() => startEdit(p)}>
                    <span className="provider-row-label">{p.label}</span>
                    <span className="provider-row-model">{p.model || "no model set"}</span>
                    <span className={`provider-row-key${p.hasKey ? " ok" : ""}`}>
                      {p.hasKey ? "key stored" : "no key"}
                    </span>
                  </button>
                  <button type="button" className="icon-btn" title="Delete provider" onClick={() => void remove(p.id)}>
                    <Trash2 size={15} />
                  </button>
                </div>
              ))
            )}
            <button type="button" className="add-provider-btn" onClick={startNew} disabled={!firstPreset}>
              <Plus size={14} /> Add provider
            </button>
          </div>

          {draft && preset ? (
            <div className="provider-form">
              <label className="field">
                <span>Provider</span>
                <select value={draft.presetId} onChange={(e) => selectPreset(e.target.value)}>
                  {presets.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              {preset.note ? <p className="field-note">{preset.note}</p> : null}

              <label className="field">
                <span>Name</span>
                <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
              </label>

              <label className="field">
                <span>Base URL</span>
                <input
                  value={draft.baseUrl}
                  placeholder="https://…"
                  onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
                />
              </label>

              {isAzure ? (
                <>
                  <label className="field">
                    <span>Deployment</span>
                    <input value={draft.deployment} onChange={(e) => setDraft({ ...draft, deployment: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>API version</span>
                    <input value={draft.apiVersion} onChange={(e) => setDraft({ ...draft, apiVersion: e.target.value })} />
                  </label>
                </>
              ) : null}

              {isBedrock ? (
                <>
                  <label className="field">
                    <span>Region</span>
                    <input value={draft.region} placeholder="us-east-1" onChange={(e) => setDraft({ ...draft, region: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Access key id</span>
                    <input value={draft.accessKeyId} onChange={(e) => setDraft({ ...draft, accessKeyId: e.target.value })} />
                  </label>
                  <label className="field">
                    <span>Secret access key</span>
                    <input
                      type="password"
                      value={draft.secretAccessKey}
                      placeholder={draft.hasKey ? "•••• stored — leave blank to keep" : ""}
                      onChange={(e) => setDraft({ ...draft, secretAccessKey: e.target.value })}
                    />
                  </label>
                  <label className="field">
                    <span>Session token (optional)</span>
                    <input type="password" value={draft.sessionToken} onChange={(e) => setDraft({ ...draft, sessionToken: e.target.value })} />
                  </label>
                </>
              ) : (
                <label className="field">
                  <span>API key</span>
                  <input
                    type="password"
                    value={draft.apiKey}
                    placeholder={draft.hasKey ? "•••• stored — leave blank to keep" : "paste key"}
                    onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
                  />
                </label>
              )}

              <label className="field">
                <span>Model id</span>
                <input value={draft.model} placeholder="e.g. gpt-4o-mini" onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
              </label>

              {test && test.ok && test.models && test.models.length > 0 ? (
                <div className="model-suggestions">
                  {test.models.slice(0, 40).map((m) => (
                    <button
                      type="button"
                      key={m}
                      className={`model-chip${m === draft.model ? " selected" : ""}`}
                      onClick={() => setDraft({ ...draft, model: m })}
                    >
                      {m}
                    </button>
                  ))}
                </div>
              ) : null}

              {test ? (
                <p className={`test-result${test.ok ? " ok" : " err"}`}>
                  {test.ok
                    ? test.unverified
                      ? "Config accepted — this provider can't be verified without spending tokens."
                      : `Connected — ${test.models?.length ?? 0} models available.`
                    : `Failed: ${test.error}`}
                </p>
              ) : null}

              {formError ? <p className="test-result err">{formError}</p> : null}

              <div className="form-actions">
                <button type="button" className="ghost-btn" onClick={() => void runTest()} disabled={testing}>
                  {testing ? <Loader2 size={13} className="spin" /> : null} Test connection
                </button>
                <span className="spacer" />
                <button type="button" className="ghost-btn" onClick={() => setDraft(null)}>
                  Cancel
                </button>
                <button type="button" className="primary-btn" onClick={() => void save()} disabled={saving}>
                  {saving ? <Loader2 size={13} className="spin" /> : <Check size={13} />} Save
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
