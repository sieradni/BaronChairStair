/**
 * A player's Discord picture, with a monogram behind it.
 *
 * Its own module because a profile is not going to be the only place that
 * wants one: the plan is a screen for reading other people's, and every board
 * in this app already carries the `avatarUrl` it would need. Nothing here knows
 * whose picture it is drawing, which is what makes that cheap later.
 *
 * **The monogram is not a placeholder, it is the floor.** Two things routinely
 * mean there is no picture to draw:
 *
 * - the player has no avatar set, and `avatarUrl` is null. Ordinary.
 * - the request for it is refused. Avatars live on `cdn.discordapp.com`, which
 *   is an external host, and an activity runs inside a frame that only reaches
 *   what Discord's URL mapping lets it. Every other request this client makes
 *   goes to its own origin under `/.proxy`; this is the first that does not.
 *
 * So the monogram is drawn first and the image sits on top of it, and a picture
 * that fails to arrive simply never covers it. No flash of a broken-image icon,
 * no layout shift, and nothing to configure before the screen is usable.
 */

import type { PlayerProfile } from "../api";
import { el } from "./dom";

export interface AvatarOptions {
  /** Pixel size of the square. CSS can still override it. */
  readonly size?: number;
}

/** The letter behind the picture. Fixed per name, so it never looks random. */
function monogram(username: string): string {
  // `[...name]` rather than `name[0]`, so a name starting with an emoji or any
  // astral character gets its whole first character instead of half of one.
  const first = [...username.trim()][0];
  return (first ?? "?").toUpperCase();
}

export function playerAvatar(player: PlayerProfile, options: AvatarOptions = {}): HTMLElement {
  const size = options.size ?? 56;
  const frame = el(
    "span",
    {
      class: "avatar",
      style: { width: `${size}px`, height: `${size}px` },
      // The name is already beside it everywhere this is used, so announcing it
      // again is noise in a screen reader rather than detail.
      attrs: { "aria-hidden": "true" },
    },
    el("span", { class: "avatar__monogram", text: monogram(player.username) }),
  );

  if (!player.avatarUrl) return frame;

  const image = el("img", {
    class: "avatar__image",
    attrs: {
      src: player.avatarUrl,
      alt: "",
      decoding: "async",
      loading: "lazy",
      // Discord's CDN does not need a referrer and sending one from inside an
      // activity frame leaks the activity's URL to it for nothing.
      referrerpolicy: "no-referrer",
    },
  });
  // Removed rather than hidden: an <img> that failed keeps its broken state and
  // some browsers draw an icon in it regardless of opacity.
  image.addEventListener("error", () => image.remove());
  frame.append(image);
  return frame;
}
