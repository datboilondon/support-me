import type { Creator } from "@prisma/client";
import { toAmount } from "./money";

/** Public allowlist: never serialize the owning account or newly added DB fields. */
export function toPublicCreator(creator: Creator) {
  return {
    // Discover uses the creator id as a stable key; it is not the account userId.
    id: creator.id,
    username: creator.username,
    walletAddress: creator.walletAddress,
    displayName: creator.displayName,
    bio: creator.bio,
    avatarUrl: creator.avatarUrl,
    socialLinks: creator.socialLinks,
    acceptsXlm: creator.acceptsXlm,
    acceptsUsdc: creator.acceptsUsdc,
    acceptsUsdt: creator.acceptsUsdt,
    donationGoal: creator.donationGoal,
    presetAmounts: creator.presetAmounts?.map(toAmount),
    theme: creator.theme,
    createdAt: creator.createdAt,
    updatedAt: creator.updatedAt,
  };
}
