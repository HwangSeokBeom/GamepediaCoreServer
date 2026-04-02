const commonAliases = require('./common.aliases');
const koAliases = require('./ko.aliases');
const jaAliases = require('./ja.aliases');
const zhHansAliases = require('./zhHans.aliases');
const enAliases = require('./en.aliases');

const SEARCH_ALIAS_BUCKETS = {
  common: commonAliases,
  ko: koAliases,
  en: enAliases,
  ja: jaAliases,
  'zh-Hans': zhHansAliases,
};

function buildSearchAliasRules() {
  return Object.entries(SEARCH_ALIAS_BUCKETS).flatMap(([locale, rules]) =>
    (rules ?? []).map((rule) => ({
      ...rule,
      locale
    }))
  );
}

module.exports = {
  SEARCH_ALIAS_BUCKETS,
  buildSearchAliasRules
};
