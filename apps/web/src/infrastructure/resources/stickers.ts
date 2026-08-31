import { stickerIds, type StickerId } from "@live2d-chat/shared";

export interface StickerManifestEntry {
  stickerId: StickerId;
  name: string;
  path: string;
  alt: string;
}

/** Runtime allowlist. The matching JSON file is public metadata for the picker. */
export const ICE_GIRL_STICKERS: readonly StickerManifestEntry[] = [
  { stickerId: "ice-girl-joy", name: "Joy", path: "/stickers/ice-girl/joy.png", alt: "Ice Girl smiling brightly" },
  { stickerId: "ice-girl-laugh", name: "Laugh", path: "/stickers/ice-girl/laugh.png", alt: "Ice Girl laughing" },
  { stickerId: "ice-girl-love", name: "Love", path: "/stickers/ice-girl/love.png", alt: "Ice Girl making a heart gesture" },
  { stickerId: "ice-girl-shy", name: "Shy", path: "/stickers/ice-girl/shy.png", alt: "Ice Girl looking shy" },
  { stickerId: "ice-girl-surprised", name: "Surprised", path: "/stickers/ice-girl/surprised.png", alt: "Ice Girl looking surprised" },
  { stickerId: "ice-girl-confused", name: "Confused", path: "/stickers/ice-girl/confused.png", alt: "Ice Girl thinking in confusion" },
  { stickerId: "ice-girl-angry", name: "Angry", path: "/stickers/ice-girl/angry.png", alt: "Ice Girl looking angry" },
  { stickerId: "ice-girl-sad", name: "Sad", path: "/stickers/ice-girl/sad.png", alt: "Ice Girl looking sad" },
  { stickerId: "ice-girl-crying", name: "Crying", path: "/stickers/ice-girl/crying.png", alt: "Ice Girl crying" },
  { stickerId: "ice-girl-proud", name: "Proud", path: "/stickers/ice-girl/proud.png", alt: "Ice Girl posing proudly" },
  { stickerId: "ice-girl-sleepy", name: "Sleepy", path: "/stickers/ice-girl/sleepy.png", alt: "Ice Girl sleeping" },
  { stickerId: "ice-girl-cheering", name: "Cheering", path: "/stickers/ice-girl/cheering.png", alt: "Ice Girl cheering" },
] as const;

const installedStickerIds = new Set(ICE_GIRL_STICKERS.map((sticker) => sticker.stickerId));
if (installedStickerIds.size !== stickerIds.length
  || stickerIds.some((stickerId) => !installedStickerIds.has(stickerId))) {
  throw new Error("The installed sticker manifest does not match the shared sticker allowlist.");
}

export function getSticker(stickerId: string): StickerManifestEntry | undefined {
  return ICE_GIRL_STICKERS.find((sticker) => sticker.stickerId === stickerId);
}
