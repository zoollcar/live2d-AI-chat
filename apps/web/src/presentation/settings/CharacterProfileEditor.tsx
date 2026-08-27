import { useEffect, useRef, useState } from "react";
import {
  defaultCharacterProfile,
  parseCharacterProfileJson,
  serializeCharacterProfile,
  type CharacterProfile,
} from "@/model/character-profile";
import { useCharacterStore } from "@/infrastructure/character/store";

function downloadProfile(profile: CharacterProfile) {
  const blob = new Blob([serializeCharacterProfile(profile)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${profile.id}.character.json`;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function CharacterProfileEditor({ onActivateProfile, onClose }: {
  onActivateProfile(profile: CharacterProfile): Promise<void>;
  onClose(): void;
}) {
  const { profiles, activeProfileId, setActiveProfile, upsertProfile, removeProfile } = useCharacterStore();
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];
  const [json, setJson] = useState(() => serializeCharacterProfile(activeProfile));
  const [status, setStatus] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setJson(serializeCharacterProfile(activeProfile));
  }, [activeProfile]);

  const save = async () => {
    try {
      const profile = parseCharacterProfileJson(json);
      upsertProfile(profile);
      await onActivateProfile(profile);
      setJson(serializeCharacterProfile(profile));
      setStatus(`Saved and activated ${profile.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to save the profile.");
    }
  };

  const createProfile = () => {
    const suffix = Date.now().toString(36);
    const profile = {
      ...defaultCharacterProfile,
      id: `character-${suffix}`,
      name: "New Character",
      live2d: { ...defaultCharacterProfile.live2d, defaultDecorations: [] },
      voice: {},
    } satisfies CharacterProfile;
    setJson(serializeCharacterProfile(profile));
    setStatus("Edit the JSON, then save to add and activate this character.");
  };

  const importFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      const profile = parseCharacterProfileJson(await file.text());
      upsertProfile(profile);
      await onActivateProfile(profile);
      setStatus(`Imported and activated ${profile.name}.`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to import the profile.");
    } finally {
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="history-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="history-dialog character-profile-dialog" role="dialog" aria-modal="true" aria-labelledby="character-profile-title">
        <header className="history-header">
          <div><p className="eyebrow">CHARACTER LIBRARY</p><h2 id="character-profile-title">Character profiles</h2></div>
          <div className="history-header-actions">
            <button onClick={createProfile}>New</button>
            <button onClick={() => downloadProfile(activeProfile)}>Export</button>
            <button onClick={() => fileInputRef.current?.click()}>Import</button>
            <button className="icon-button" onClick={onClose} aria-label="Close character profiles">×</button>
          </div>
        </header>
        <input
          ref={fileInputRef}
          className="visually-hidden"
          type="file"
          accept="application/json,.json"
          onChange={(event) => void importFile(event.target.files?.[0])}
        />
        <div className="character-profile-body">
          <p className="status-copy">A profile switches the prompt, greeting, bundled Live2D appearance, stage layout, and optional voice overrides together. Live2D model import is not available yet.</p>
          <label className="field">
            <span>Active character</span>
            <select value={activeProfileId} onChange={(event) => {
              const profile = profiles.find((item) => item.id === event.target.value);
              if (!profile) return;
              setActiveProfile(profile.id);
              void onActivateProfile(profile);
              setStatus("");
            }}>
              {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
          </label>
          <label className="field character-json-field">
            <span>Profile JSON</span>
            <textarea className="character-json" value={json} onChange={(event) => setJson(event.target.value)} spellCheck={false} />
          </label>
          <div className="character-actions">
            <button className="primary-button" onClick={() => void save()}>Save &amp; activate</button>
            <button className="danger-button" disabled={profiles.length <= 1} onClick={() => {
              removeProfile(activeProfile.id);
              const next = useCharacterStore.getState().profiles.find((profile) =>
                profile.id === useCharacterStore.getState().activeProfileId);
              if (next) void onActivateProfile(next);
            }}>Delete</button>
          </div>
        </div>
        {status ? <footer className="conversation-library-status" role="status">{status}</footer> : null}
      </section>
    </div>
  );
}
