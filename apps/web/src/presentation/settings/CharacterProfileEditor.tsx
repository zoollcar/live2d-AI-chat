import { useEffect, useRef, useState } from "react";
import { stageLayoutIds } from "@live2d-chat/shared";
import { agentToolNames, type AgentToolName } from "@/agent/tool-context";
import { useCharacterStore } from "@/infrastructure/character/store";
import { characterProfileSchema, defaultCharacterProfile, parseCharacterProfileJson, serializeCharacterProfile, type CharacterProfile } from "@/model/character-profile";
import { decorationIds, live2dCatalog, stateIds } from "@/model/live2d/catalog";

const toolLabels: Record<AgentToolName, string> = {
  setState: "Set character state", setDecorations: "Set decorations", performAction: "Perform character action", setStageLayout: "Change stage layout",
  listResources: "List attached content", readResource: "Read attached content", readWebPage: "Read web pages", readVideoTranscript: "Read video transcripts",
  showResourceOnStage: "Show content on stage", closeStageContent: "Close stage content", drawSvgOnStage: "Draw SVG on stage", sendSticker: "Send stickers", inspectImage: "Inspect images",
};

function downloadProfile(profile: CharacterProfile) {
  const url = URL.createObjectURL(new Blob([serializeCharacterProfile(profile)], { type: "application/json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${profile.id}.character.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function CharacterProfileEditor({ onActivateProfile, onClose }: { onActivateProfile(profile: CharacterProfile): Promise<void>; onClose(): void }) {
  const { profiles, activeProfileId, setActiveProfile, upsertProfile, removeProfile } = useCharacterStore();
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const [draft, setDraft] = useState<CharacterProfile>(activeProfile);
  const [status, setStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => setDraft(activeProfile), [activeProfile]);

  const update = <Key extends keyof CharacterProfile>(key: Key, value: CharacterProfile[Key]) => setDraft((current) => ({ ...current, [key]: value }));
  const updateLive2d = (value: Partial<CharacterProfile["live2d"]>) => setDraft((current) => ({ ...current, live2d: { ...current.live2d, ...value } }));
  const updateVoice = (value: Partial<CharacterProfile["voice"]>) => setDraft((current) => ({ ...current, voice: { ...current.voice, ...value } }));

  const save = async () => {
    try {
      const profile = characterProfileSchema.parse(draft);
      upsertProfile(profile);
      await onActivateProfile(profile);
      setDraft(profile);
      setStatus(`Saved and activated ${profile.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to save the profile.");
    }
  };

  const createProfile = () => {
    setDraft({ ...defaultCharacterProfile, id: `character-${Date.now().toString(36)}`, name: "New Character", live2d: { ...defaultCharacterProfile.live2d, defaultDecorations: [] }, voice: {}, enabledTools: [...agentToolNames] });
    setStatus("Complete the form, then save to add and activate this character.");
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const profile = parseCharacterProfileJson(await file.text());
      upsertProfile(profile);
      await onActivateProfile(profile);
      setDraft(profile);
      setStatus(`Imported and activated ${profile.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to import the profile.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return <div className="history-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="history-dialog character-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="character-profile-title">
      <header className="history-header"><div><p className="eyebrow">CHARACTER LIBRARY</p><h2 id="character-profile-title">Character profiles</h2></div><div className="history-header-actions">
        <button onClick={createProfile}>New</button><button onClick={() => downloadProfile(draft)}>Export</button><button onClick={() => fileInputRef.current?.click()}>Import</button><button className="icon-button" onClick={onClose} aria-label="Close character profiles">×</button>
      </div></header>
      <input ref={fileInputRef} className="visually-hidden" type="file" accept="application/json,.json" onChange={(event) => void importFile(event.target.files?.[0])} />
      <div className="character-profile-body">
        <p className="status-copy">Edit profiles with the form below. JSON is only used for import and export.</p>
        <label className="field"><span>Active character</span><select value={activeProfileId} onChange={(event) => { const profile = profiles.find((item) => item.id === event.target.value); if (!profile) return; setActiveProfile(profile.id); void onActivateProfile(profile); setStatus(""); }}>{profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <div className="character-form-grid"><label className="field"><span>ID</span><input value={draft.id} onChange={(event) => update("id", event.target.value)} /></label><label className="field"><span>Name</span><input value={draft.name} onChange={(event) => update("name", event.target.value)} /></label></div>
        <label className="field"><span>Description</span><textarea value={draft.description} onChange={(event) => update("description", event.target.value)} /></label>
        <label className="field"><span>Personality</span><textarea value={draft.personality} onChange={(event) => update("personality", event.target.value)} /></label>
        <label className="field"><span>Scenario</span><textarea value={draft.scenario} onChange={(event) => update("scenario", event.target.value)} /></label>
        <label className="field"><span>First message</span><textarea value={draft.firstMessage} onChange={(event) => update("firstMessage", event.target.value)} /></label>
        <label className="field"><span>Example dialogue</span><textarea value={draft.exampleDialogue ?? ""} onChange={(event) => update("exampleDialogue", event.target.value || undefined)} /></label>
        <label className="field"><span>Additional system prompt</span><textarea value={draft.systemPrompt ?? ""} onChange={(event) => update("systemPrompt", event.target.value || undefined)} /></label>

        <details className="profile-form-section" open><summary>Appearance</summary><div className="character-form-grid">
          <label className="field"><span>Live2D model</span><select value={draft.live2d.modelId} disabled><option value={live2dCatalog.id}>{live2dCatalog.id}</option></select></label>
          <label className="field"><span>Default state</span><select value={draft.live2d.defaultState} onChange={(event) => updateLive2d({ defaultState: event.target.value as CharacterProfile["live2d"]["defaultState"] })}>{stateIds.map((state) => <option key={state} value={state}>{state}</option>)}</select></label>
          <label className="field"><span>Default layout</span><select value={draft.live2d.defaultLayout} onChange={(event) => updateLive2d({ defaultLayout: event.target.value as CharacterProfile["live2d"]["defaultLayout"] })}>{stageLayoutIds.map((layout) => <option key={layout} value={layout}>{layout}</option>)}</select></label>
        </div><fieldset className="profile-checkbox-grid"><legend>Default decorations</legend>{decorationIds.map((decoration) => <label key={decoration}><input type="checkbox" checked={draft.live2d.defaultDecorations.includes(decoration)} onChange={(event) => { const compatible = decoration === "ponytail" ? draft.live2d.defaultDecorations.filter((item) => item !== "hair-down") : decoration === "hair-down" ? draft.live2d.defaultDecorations.filter((item) => item !== "ponytail") : draft.live2d.defaultDecorations; updateLive2d({ defaultDecorations: event.target.checked ? [...compatible, decoration] : compatible.filter((item) => item !== decoration) }); }} />{decoration}</label>)}</fieldset></details>

        <details className="profile-form-section"><summary>Voice overrides</summary><div className="character-form-grid">
          <label className="field"><span>TTS provider</span><select value={draft.voice.ttsProvider ?? ""} onChange={(event) => updateVoice({ ttsProvider: event.target.value ? event.target.value as NonNullable<CharacterProfile["voice"]["ttsProvider"]> : undefined })}><option value="">Use global setting</option><option value="vits-local">VITS local</option><option value="browser-speech">Browser speech</option><option value="openai-compatible">OpenAI compatible</option><option value="google-cloud">Google Cloud</option></select></label>
          <label className="field"><span>Voice</span><input value={draft.voice.voice ?? ""} onChange={(event) => updateVoice({ voice: event.target.value || undefined })} /></label><label className="field"><span>Language</span><input value={draft.voice.language ?? ""} onChange={(event) => updateVoice({ language: event.target.value || undefined })} /></label>
          <label className="field"><span>Rate</span><input type="number" min="0.5" max="2" step="0.1" value={draft.voice.rate ?? ""} onChange={(event) => updateVoice({ rate: event.target.value ? Number(event.target.value) : undefined })} /></label><label className="field"><span>Pitch</span><input type="number" min="0.5" max="2" step="0.1" value={draft.voice.pitch ?? ""} onChange={(event) => updateVoice({ pitch: event.target.value ? Number(event.target.value) : undefined })} /></label>
        </div></details>

        <details className="profile-form-section" open><summary>Tools</summary><p className="settings-section-copy">Disabled tools are not exposed to the model for this profile.</p><fieldset className="profile-checkbox-grid"><legend>Enabled tools</legend>{agentToolNames.map((toolName) => <label key={toolName}><input type="checkbox" checked={draft.enabledTools.includes(toolName)} onChange={(event) => update("enabledTools", event.target.checked ? [...draft.enabledTools, toolName] : draft.enabledTools.filter((name) => name !== toolName))} />{toolLabels[toolName]}</label>)}</fieldset></details>
        <div className="character-actions"><button className="primary-button" onClick={() => void save()}>Save &amp; activate</button><button className="danger-button" disabled={profiles.length <= 1} onClick={() => { removeProfile(activeProfile.id); const next = useCharacterStore.getState().profiles.find((profile) => profile.id === useCharacterStore.getState().activeProfileId); if (next) void onActivateProfile(next); }}>Delete</button></div>
      </div>
      {status ? <footer className="conversation-library-status" role="status">{status}</footer> : null}
    </section>
  </div>;
}
