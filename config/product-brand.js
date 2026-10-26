import brand from "./product-brand.cjs";

export const PRODUCT_BRAND = brand;
export const PREVIEW_PRODUCT_BRAND = Object.freeze({
  ...brand,
  displayName: brand.previewDisplayName,
});
