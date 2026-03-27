const { normalizeQuery } = require('./igdb.search-utils');

const MIN_PREFIX_ALIAS_LENGTH = 2;
const MIN_PREFIX_ALIAS_CONFIDENCE = 0.4;

const SEARCH_ALIAS_RULES = [
  {
    target: 'cyberpunk 2077',
    aliases: [
      '싸펑',
      '사펑',
      '사이버펑크',
      '사이버 펑크',
      '사이버펑크2077',
      '사이버 펑크 2077',
      '사펑2077',
      '싸펑2077',
      'cyber funk',
      'cyberfunk'
    ],
    canonicalQueries: ['cyberpunk']
  },
  {
    target: 'witcher',
    aliases: [
      '위쳐'
    ]
  },
  {
    target: 'witcher 3',
    aliases: [
      '위쳐3',
      '위쳐 3'
    ],
    canonicalQueries: ['witcher']
  },
  {
    target: 'elden ring',
    aliases: [
      '엘든링',
      '엘든 링',
      '엘든'
    ],
    canonicalQueries: ['elden ring']
  },
  {
    target: 'sekiro shadows die twice',
    aliases: [
      '세키로'
    ],
    canonicalQueries: ['sekiro']
  },
  {
    target: 'dark souls',
    aliases: [
      '닼소',
      '다크소울',
      '다크 소울'
    ],
    canonicalQueries: ['dark souls']
  },
  {
    target: 'bloodborne',
    aliases: [
      '블본',
      '블러드본'
    ]
  },
  {
    target: 'zelda',
    aliases: [
      '젤다'
    ],
    canonicalQueries: ['zelda']
  },
  {
    target: 'zelda breath of the wild',
    aliases: [
      '야숨',
      '젤숨',
      '젤다야숨',
      '젤다 야숨',
      '브레스 오브 더 와일드',
      '브오와'
    ],
    canonicalQueries: ['zelda', 'breath of the wild']
  },
  {
    target: 'zelda tears of the kingdom',
    aliases: [
      '왕눈',
      '왕눈이',
      '젤다왕눈',
      '젤다 왕눈',
      '왕국의눈물',
      '왕국의 눈물',
      '티어스 오브 더 킹덤',
      'totk'
    ],
    canonicalQueries: ['zelda', 'tears of the kingdom', 'totk']
  },
  {
    target: 'super mario',
    aliases: [
      '마리오',
      '슈퍼마리오'
    ],
    canonicalQueries: ['mario']
  },
  {
    target: 'mario kart',
    aliases: [
      '마카',
      '마리오카트',
      '마리오 카트'
    ],
    canonicalQueries: ['mario kart']
  },
  {
    target: 'animal crossing',
    aliases: [
      '동숲',
      '동물의숲',
      '동물의 숲'
    ],
    canonicalQueries: ['animal crossing']
  },
  {
    target: 'pokemon',
    aliases: [
      '포켓몬',
      '포켓몬스터'
    ]
  },
  {
    target: 'super smash bros',
    aliases: [
      '스매시',
      '스매시브라더스'
    ],
    canonicalQueries: ['smash bros', 'smash']
  },
  {
    target: 'splatoon',
    aliases: [
      '스플래툰'
    ]
  },
  {
    target: 'fire emblem',
    aliases: [
      '파엠'
    ],
    canonicalQueries: ['fire emblem']
  },
  {
    target: 'kirby',
    aliases: [
      '별의커비',
      '커비'
    ]
  },
  {
    target: 'red dead redemption',
    aliases: [
      '레데리',
      '레드데드리뎀션',
      '레드 데드 리뎀션'
    ],
    canonicalQueries: ['red dead redemption']
  },
  {
    target: 'red dead redemption 2',
    aliases: [
      '레데리2',
      '레데리 2'
    ],
    canonicalQueries: ['red dead redemption', 'red dead redemption 2']
  },
  {
    target: 'grand theft auto',
    aliases: [
      'gta',
      '그타'
    ],
    canonicalQueries: ['grand theft auto']
  },
  {
    target: 'grand theft auto v',
    aliases: [
      'gta5',
      'gta 5',
      '그타5'
    ],
    canonicalQueries: ['grand theft auto', 'grand theft auto v']
  },
  {
    target: 'last of us',
    aliases: [
      '라오어'
    ],
    canonicalQueries: ['last of us']
  },
  {
    target: 'last of us part ii',
    aliases: [
      '라오어2',
      '라오어 2'
    ],
    canonicalQueries: ['last of us', 'part ii']
  },
  {
    target: 'god of war',
    aliases: [
      '갓오워',
      '갓 오브 워'
    ]
  },
  {
    target: 'horizon zero dawn',
    aliases: [
      '호제던'
    ],
    canonicalQueries: ['horizon']
  },
  {
    target: 'horizon forbidden west',
    aliases: [
      '호포웨'
    ],
    canonicalQueries: ['horizon']
  },
  {
    target: 'horizon',
    aliases: [
      '호라이즌'
    ],
    canonicalQueries: ['horizon']
  },
  {
    target: 'death stranding',
    aliases: [
      '데스스트랜딩',
      '데스 스트랜딩'
    ]
  },
  {
    target: 'ghost of tsushima',
    aliases: [
      '고오쓰',
      '고스트 오브 쓰시마'
    ]
  },
  {
    target: 'league of legends',
    aliases: [
      '롤',
      '리그오브레전드',
      '리그 오브 레전드'
    ],
    canonicalQueries: ['league of legends']
  },
  {
    target: 'valorant',
    aliases: [
      '발로',
      '발로란트'
    ]
  },
  {
    target: 'overwatch',
    aliases: [
      '옵치',
      '오버워치'
    ]
  },
  {
    target: 'diablo',
    aliases: [
      '디아'
    ],
    canonicalQueries: ['diablo']
  },
  {
    target: 'diablo iv',
    aliases: [
      '디아4',
      '디아 4'
    ],
    canonicalQueries: ['diablo', 'diablo iv']
  },
  {
    target: 'world of warcraft',
    aliases: [
      '와우'
    ],
    canonicalQueries: ['warcraft']
  },
  {
    target: 'hearthstone',
    aliases: [
      '하스',
      '하스스톤'
    ]
  },
  {
    target: 'starcraft',
    aliases: [
      '스타'
    ],
    canonicalQueries: ['starcraft']
  },
  {
    target: 'starcraft 2',
    aliases: [
      '스타2',
      '스타 2'
    ],
    canonicalQueries: ['starcraft', 'starcraft 2']
  },
  {
    target: 'lost ark',
    aliases: [
      '로아',
      '로스트아크'
    ]
  },
  {
    target: 'black desert',
    aliases: [
      '검사',
      '검은사막'
    ],
    canonicalQueries: ['black desert']
  },
  {
    target: 'dungeon fighter',
    aliases: [
      '던파',
      '던전앤파이터'
    ],
    canonicalQueries: ['dungeon fighter']
  },
  {
    target: 'maplestory',
    aliases: [
      '메이플',
      '메이플스토리'
    ]
  },
  {
    target: 'lineage',
    aliases: [
      '리니지'
    ]
  },
  {
    target: 'aion',
    aliases: [
      '아이온'
    ]
  },
  {
    target: 'monster hunter',
    aliases: [
      '몬헌'
    ],
    canonicalQueries: ['monster hunter']
  },
  {
    target: 'monster hunter world',
    aliases: [
      '몬헌월드',
      '몬헌 월드'
    ],
    canonicalQueries: ['monster hunter', 'monster hunter world']
  },
  {
    target: 'monster hunter rise',
    aliases: [
      '몬헌라이즈',
      '몬헌 라이즈'
    ],
    canonicalQueries: ['monster hunter', 'monster hunter rise']
  },
  {
    target: 'resident evil',
    aliases: [
      '바하',
      '레지던트이블',
      '레지던트 이블'
    ],
    canonicalQueries: ['resident evil']
  },
  {
    target: 'resident evil 4',
    aliases: [
      '바하4',
      '바하 4'
    ],
    canonicalQueries: ['resident evil', 'resident evil 4']
  },
  {
    target: 'devil may cry',
    aliases: [
      'dmc',
      '데메크'
    ],
    canonicalQueries: ['devil may cry', 'dmc']
  },
  {
    target: 'final fantasy',
    aliases: [
      '파판',
      '파이널판타지',
      '파이널 판타지'
    ],
    canonicalQueries: ['final fantasy']
  },
  {
    target: 'final fantasy vii',
    aliases: [
      '파판7',
      '파판 7'
    ],
    canonicalQueries: ['final fantasy', 'final fantasy vii']
  },
  {
    target: 'final fantasy xiv',
    aliases: [
      '파판14',
      '파판 14'
    ],
    canonicalQueries: ['final fantasy', 'final fantasy xiv']
  },
  {
    target: 'persona',
    aliases: [
      '페르소나'
    ],
    canonicalQueries: ['persona']
  },
  {
    target: 'persona 5',
    aliases: [
      '페르소나5',
      '페르소나 5'
    ],
    canonicalQueries: ['persona', 'persona 5']
  },
  {
    target: 'dragon quest',
    aliases: [
      '드퀘',
      '드래곤퀘스트',
      '드래곤 퀘스트'
    ],
    canonicalQueries: ['dragon quest']
  },
  {
    target: 'nier',
    aliases: [
      '니어'
    ],
    canonicalQueries: ['nier']
  },
  {
    target: 'nier automata',
    aliases: [
      '니어오토마타',
      '니어 오토마타'
    ],
    canonicalQueries: ['nier', 'nier automata']
  },
  {
    target: 'stardew valley',
    aliases: [
      '스타듀',
      '스타듀밸리',
      '스타듀 밸리'
    ],
    canonicalQueries: ['stardew valley']
  },
  {
    target: 'hollow knight',
    aliases: [
      '할나',
      '할로우나이트',
      '할로우 나이트'
    ],
    canonicalQueries: ['hollow knight']
  },
  {
    target: 'hades',
    aliases: [
      '하데스'
    ]
  },
  {
    target: 'dead cells',
    aliases: [
      '데드셀'
    ]
  },
  {
    target: 'cuphead',
    aliases: [
      '컵헤드'
    ]
  },
  {
    target: 'undertale',
    aliases: [
      '언더테일'
    ]
  },
  {
    target: 'rimworld',
    aliases: [
      '림월드'
    ]
  },
  {
    target: 'valheim',
    aliases: [
      '발헤임'
    ]
  },
  {
    target: 'terraria',
    aliases: [
      '테라리아'
    ]
  },
  {
    target: 'factorio',
    aliases: [
      '팩토리오'
    ]
  },
  {
    target: 'slay the spire',
    aliases: [
      '슬더스'
    ],
    canonicalQueries: ['slay the spire']
  },
  {
    target: 'no man\'s sky',
    aliases: [
      '노맨즈',
      '노맨즈스카이',
      '노맨즈 스카이'
    ],
    canonicalQueries: ['no man\'s sky']
  },
  {
    target: 'minecraft',
    aliases: [
      '마크',
      '마인크래프트'
    ]
  },
  {
    target: 'palworld',
    aliases: [
      '팰월드'
    ]
  },
  {
    target: 'rust',
    aliases: [
      '러스트'
    ]
  },
  {
    target: 'ark survival evolved',
    aliases: [
      '아크'
    ],
    canonicalQueries: ['ark']
  },
  {
    target: 'subnautica',
    aliases: [
      '서브노티카'
    ]
  },
  {
    target: 'ea sports fc',
    aliases: [
      '피파'
    ],
    canonicalQueries: ['ea sports fc']
  },
  {
    target: 'ea sports fc 24',
    aliases: [
      'fc24',
      'fc 24'
    ],
    canonicalQueries: ['ea sports fc', 'ea sports fc 24']
  },
  {
    target: 'efootball',
    aliases: [
      '위닝'
    ]
  },
  {
    target: 'forza horizon',
    aliases: [
      '포르자'
    ],
    canonicalQueries: ['forza']
  },
  {
    target: 'gran turismo',
    aliases: [
      '그란투리스모'
    ]
  },
  {
    target: 'need for speed',
    aliases: [
      '니드포스피드',
      '니드 포 스피드'
    ]
  }
];

const exactAliasMap = new Map();
const prefixAliasEntries = [];

initializeAliasLookups();

function containsNonAscii(value) {
  return /[^\x00-\x7F]/.test(value);
}

function buildAliasCandidateQueries(rule) {
  const candidates = [];
  const targetInfo = normalizeQuery(rule.target);

  if (targetInfo.normalized) {
    candidates.push(targetInfo.normalized);
  }

  for (const canonicalQuery of rule.canonicalQueries ?? []) {
    const canonicalInfo = normalizeQuery(canonicalQuery);

    if (canonicalInfo.normalized && !candidates.includes(canonicalInfo.normalized)) {
      candidates.push(canonicalInfo.normalized);
    }

    if (canonicalInfo.compact.length >= MIN_PREFIX_ALIAS_LENGTH) {
      const wildcardCandidate = `${canonicalInfo.compact}*`;

      if (!candidates.includes(wildcardCandidate)) {
        candidates.push(wildcardCandidate);
      }
    }
  }

  return candidates.slice(0, 3);
}

function createAliasEntry(rule, alias, order) {
  const aliasInfo = normalizeQuery(alias);
  const targetInfo = normalizeQuery(rule.target);

  return {
    target: rule.target,
    matchedAliasKey: aliasInfo.compact || aliasInfo.normalized,
    normalizedAlias: aliasInfo.normalized,
    compactAlias: aliasInfo.compact,
    allowsSingleCharacterPrefix:
      aliasInfo.compact.length <= 2 &&
      targetInfo.tokens.length <= 1,
    candidateQueries: buildAliasCandidateQueries(rule),
    order
  };
}

function initializeAliasLookups() {
  let order = 0;

  for (const rule of SEARCH_ALIAS_RULES) {
    for (const alias of rule.aliases) {
      const aliasEntry = createAliasEntry(rule, alias, order);
      order += 1;

      if (aliasEntry.normalizedAlias && !exactAliasMap.has(aliasEntry.normalizedAlias)) {
        exactAliasMap.set(aliasEntry.normalizedAlias, aliasEntry);
      }

      if (aliasEntry.compactAlias && !exactAliasMap.has(aliasEntry.compactAlias)) {
        exactAliasMap.set(aliasEntry.compactAlias, aliasEntry);
      }

      if (containsNonAscii(alias) && aliasEntry.compactAlias.length >= MIN_PREFIX_ALIAS_LENGTH) {
        prefixAliasEntries.push(aliasEntry);
      }
    }
  }
}

function buildResolvedAlias(aliasEntry, matchType, {
  matchedInputKey = null,
  confidence = 1
} = {}) {
  return {
    target: aliasEntry.target,
    matchedKey: aliasEntry.matchedAliasKey,
    matchedInputKey,
    matchType,
    confidence,
    candidateQueries: aliasEntry.candidateQueries
  };
}

function resolveExactSearchAlias(query) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const lookupKeys = [
    queryInfo.normalized,
    queryInfo.compact
  ].filter(Boolean);

  for (const lookupKey of lookupKeys) {
    const aliasEntry = exactAliasMap.get(lookupKey);

    if (aliasEntry) {
      return buildResolvedAlias(aliasEntry, 'exact', {
        matchedInputKey: lookupKey,
        confidence: 1
      });
    }
  }

  return null;
}

function comparePrefixAliasEntries(leftEntry, rightEntry) {
  const confidenceDifference =
    rightEntry.matchConfidence - leftEntry.matchConfidence;

  if (confidenceDifference !== 0) {
    return confidenceDifference;
  }

  const compactLengthDifference = leftEntry.compactAlias.length - rightEntry.compactAlias.length;

  if (compactLengthDifference !== 0) {
    return compactLengthDifference;
  }

  return leftEntry.order - rightEntry.order;
}

function resolvePrefixSearchAlias(query) {
  const queryInfo = typeof query === 'string' ? normalizeQuery(query) : query;
  const compactQuery = queryInfo.compact;

  if (!compactQuery) {
    return null;
  }

  const matchingAliasEntries = prefixAliasEntries
    .map((aliasEntry) => ({
      ...aliasEntry,
      matchConfidence: compactQuery.length / aliasEntry.compactAlias.length,
      minimumPrefixLength:
        aliasEntry.allowsSingleCharacterPrefix
          ? 1
          : Math.max(MIN_PREFIX_ALIAS_LENGTH, Math.ceil(aliasEntry.compactAlias.length * MIN_PREFIX_ALIAS_CONFIDENCE))
    }))
    .filter((aliasEntry) => (
      aliasEntry.compactAlias.startsWith(compactQuery) &&
      compactQuery.length >= aliasEntry.minimumPrefixLength &&
      aliasEntry.matchConfidence >= MIN_PREFIX_ALIAS_CONFIDENCE
    ));

  if (matchingAliasEntries.length === 0) {
    return null;
  }

  matchingAliasEntries.sort(comparePrefixAliasEntries);

  return buildResolvedAlias(matchingAliasEntries[0], 'prefix', {
    matchedInputKey: compactQuery,
    confidence: matchingAliasEntries[0].matchConfidence
  });
}

module.exports = {
  resolveExactSearchAlias,
  resolvePrefixSearchAlias
};
