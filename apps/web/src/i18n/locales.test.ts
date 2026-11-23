import { describe, expect, it } from "vite-plus/test";

import { resolveWebLocaleSelection } from "./locales";

describe("resolveWebLocaleSelection", () => {
  it.each([
    ["system", ["en-GB"], "en", undefined],
    ["system", ["zh-TW", "en-GB"], "zh-TW", undefined],
    ["system", ["zh-Hant-HK", "en-GB"], "zh-TW", undefined],
    ["system", ["zh-CN", "en-GB"], "zh", undefined],
    ["zh-TW", ["en-US"], "zh-TW", "zh-TW"],
    ["en", ["en-GB"], "en", undefined],
    ["en", ["de-DE"], "en", "en"],
    ["de", ["en-US"], "de", "de"],
  ] as const)("%s with browser languages %j", (language, browserLocales, catalog, formatting) => {
    expect(resolveWebLocaleSelection(language, browserLocales)).toEqual({
      catalogLocale: catalog,
      formattingLocale: formatting,
    });
  });
});
