import { BadRequestError } from "../errors/AppError";
import {
  getAcceptedCurrencies,
  isCurrencyAccepted,
  type CreatorAssetPreferences,
} from "../lib/stellarAssets";

export function assertCreatorAcceptsCurrency(
  creator: CreatorAssetPreferences,
  currency: string
): void {
  const allowedCurrencies = getAcceptedCurrencies(creator);
  if (!isCurrencyAccepted(creator, currency)) {
    throw new BadRequestError(
      `Creator does not accept ${currency}. Allowed currencies: ${allowedCurrencies.join(", ") || "none"}`
    );
  }
}
