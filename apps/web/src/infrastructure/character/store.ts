import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  characterProfileSchema,
  defaultCharacterProfile,
  type CharacterProfile,
} from "@/model/character-profile";

interface CharacterStore {
  profiles: CharacterProfile[];
  activeProfileId: string;
  upsertProfile(profile: CharacterProfile): void;
  setActiveProfile(id: string): void;
  removeProfile(id: string): void;
}

export const useCharacterStore = create<CharacterStore>()(
  persist(
    (set, get) => ({
      profiles: [defaultCharacterProfile],
      activeProfileId: defaultCharacterProfile.id,
      upsertProfile(profile) {
        const validated = characterProfileSchema.parse(profile);
        const profiles = get().profiles;
        const existing = profiles.findIndex((item) => item.id === validated.id);
        set({
          profiles: existing < 0
            ? [...profiles, validated]
            : profiles.map((item, index) => index === existing ? validated : item),
          activeProfileId: validated.id,
        });
      },
      setActiveProfile(id) {
        if (get().profiles.some((profile) => profile.id === id)) set({ activeProfileId: id });
      },
      removeProfile(id) {
        const current = get();
        if (current.profiles.length <= 1) return;
        const profiles = current.profiles.filter((profile) => profile.id !== id);
        set({
          profiles,
          activeProfileId: current.activeProfileId === id ? profiles[0].id : current.activeProfileId,
        });
      },
    }),
    {
      name: "live2d-chat:characters:v1",
      version: 1,
      merge: (persisted, current) => {
        const saved = persisted as Partial<CharacterStore> | undefined;
        const savedProfiles: unknown[] = Array.isArray(saved?.profiles) ? saved.profiles : [];
        const profiles = savedProfiles.flatMap((profile) => {
          const result = characterProfileSchema.safeParse(profile);
          return result.success ? [result.data] : [];
        });
        const safeProfiles = profiles.length > 0 ? profiles : [defaultCharacterProfile];
        const activeProfileId = safeProfiles.some((profile) => profile.id === saved?.activeProfileId)
          ? saved!.activeProfileId!
          : safeProfiles[0].id;
        return { ...current, profiles: safeProfiles, activeProfileId };
      },
    },
  ),
);
