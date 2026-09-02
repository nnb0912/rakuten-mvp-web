export type RppKeywordTargetContext = {
  itemName: string;
  itemCpc: number | null;
  owner: string;
};

type ActiveItem = RppKeywordTargetContext;

export function resolveKeywordTargetContext(input: {
  itemCode: string;
  rowItemName: string;
  rowItemCpc: number | null;
  activeItem?: ActiveItem;
  ownerMap: Record<string, string>;
  excluded: boolean;
}): RppKeywordTargetContext | null {
  if (!input.itemCode || input.excluded) return null;
  return {
    itemName: input.activeItem?.itemName || input.rowItemName,
    itemCpc: input.activeItem?.itemCpc ?? input.rowItemCpc,
    owner: input.activeItem?.owner || input.ownerMap[input.itemCode] || "担当未設定",
  };
}
