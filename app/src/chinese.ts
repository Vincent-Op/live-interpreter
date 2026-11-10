import * as OpenCC from 'opencc-js/cn2t';

// The translator writes Simplified Chinese with mainland wording. Show Traditional with Taiwan
// wording instead ("twp" also swaps phrases, e.g. 软件 -> 軟體, 出租车 -> 計程車).
const cnToTw = OpenCC.Converter({ from: 'cn', to: 'twp' });

// Taiwan terms OpenCC doesn't cover.
const TAIWAN_TERMS: [string, string][] = [
  ['地鐵站', '捷運站'],
  ['地鐵', '捷運'],
  ['火車站', '車站'],
];

export function toTaiwanese(text: string): string {
  let t = cnToTw(text);
  for (const [from, to] of TAIWAN_TERMS) t = t.split(from).join(to);
  return t;
}
