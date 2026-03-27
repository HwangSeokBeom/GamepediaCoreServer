const SEARCH_ALIAS_MAP = Object.freeze({
  "싸펑": "cyberpunk 2077",
  "사펑": "cyberpunk 2077",
  "사이버펑크": "cyberpunk 2077",
  "사이버 펑크": "cyberpunk 2077",
  "사이버펑크2077": "cyberpunk 2077",
  "사이버 펑크 2077": "cyberpunk 2077",

  "위쳐": "witcher",
  "위쳐3": "witcher 3",
  "위쳐 3": "witcher 3",

  "엘든링": "elden ring",
  "엘든 링": "elden ring",
  "엘든": "elden ring",

  "세키로": "sekiro shadows die twice",
  "닼소": "dark souls",
  "다크소울": "dark souls",
  "다크 소울": "dark souls",
  "블본": "bloodborne",
  "블러드본": "bloodborne",

  "젤다": "zelda",
  "야숨": "zelda breath of the wild",
  "젤숨": "zelda breath of the wild",
  "젤다야숨": "zelda breath of the wild",
  "젤다 야숨": "zelda breath of the wild",
  "브레스 오브 더 와일드": "zelda breath of the wild",
  "브오와": "zelda breath of the wild",

  "왕눈": "zelda tears of the kingdom",
  "젤다왕눈": "zelda tears of the kingdom",
  "젤다 왕눈": "zelda tears of the kingdom",
  "왕국의눈물": "zelda tears of the kingdom",
  "왕국의 눈물": "zelda tears of the kingdom",
  "티어스 오브 더 킹덤": "zelda tears of the kingdom",
  "totk": "zelda tears of the kingdom",

  "마리오": "super mario",
  "슈퍼마리오": "super mario",
  "마카": "mario kart",
  "마리오카트": "mario kart",
  "마리오 카트": "mario kart",
  "동숲": "animal crossing",
  "동물의숲": "animal crossing",
  "동물의 숲": "animal crossing",
  "포켓몬": "pokemon",
  "포켓몬스터": "pokemon",
  "스매시": "super smash bros",
  "스매시브라더스": "super smash bros",
  "스플래툰": "splatoon",
  "파엠": "fire emblem",
  "별의커비": "kirby",
  "커비": "kirby",

  "레데리": "red dead redemption",
  "레데리2": "red dead redemption 2",
  "레데리 2": "red dead redemption 2",
  "레드데드리뎀션": "red dead redemption",
  "레드 데드 리뎀션": "red dead redemption",

  "gta": "grand theft auto",
  "그타": "grand theft auto",
  "gta5": "grand theft auto v",
  "gta 5": "grand theft auto v",
  "그타5": "grand theft auto v",

  "라오어": "last of us",
  "라오어2": "last of us part ii",
  "라오어 2": "last of us part ii",

  "갓오워": "god of war",
  "갓 오브 워": "god of war",

  "호제던": "horizon zero dawn",
  "호포웨": "horizon forbidden west",
  "호라이즌": "horizon",

  "데스스트랜딩": "death stranding",
  "데스 스트랜딩": "death stranding",

  "고오쓰": "ghost of tsushima",
  "고스트 오브 쓰시마": "ghost of tsushima",

  "롤": "league of legends",
  "리그오브레전드": "league of legends",
  "리그 오브 레전드": "league of legends",

  "발로": "valorant",
  "발로란트": "valorant",

  "옵치": "overwatch",
  "오버워치": "overwatch",

  "디아": "diablo",
  "디아4": "diablo iv",
  "디아 4": "diablo iv",

  "와우": "world of warcraft",

  "하스": "hearthstone",
  "하스스톤": "hearthstone",

  "스타": "starcraft",
  "스타2": "starcraft 2",
  "스타 2": "starcraft 2",

  "로아": "lost ark",
  "로스트아크": "lost ark",

  "검사": "black desert",
  "검은사막": "black desert",

  "던파": "dungeon fighter",
  "던전앤파이터": "dungeon fighter",

  "메이플": "maplestory",
  "메이플스토리": "maplestory",

  "리니지": "lineage",
  "아이온": "aion",

  "몬헌": "monster hunter",
  "몬헌월드": "monster hunter world",
  "몬헌 월드": "monster hunter world",
  "몬헌라이즈": "monster hunter rise",
  "몬헌 라이즈": "monster hunter rise",

  "바하": "resident evil",
  "바하4": "resident evil 4",
  "바하 4": "resident evil 4",
  "레지던트이블": "resident evil",
  "레지던트 이블": "resident evil",

  "dmc": "devil may cry",
  "데메크": "devil may cry",

  "파판": "final fantasy",
  "파판7": "final fantasy vii",
  "파판 7": "final fantasy vii",
  "파판14": "final fantasy xiv",
  "파판 14": "final fantasy xiv",
  "파이널판타지": "final fantasy",
  "파이널 판타지": "final fantasy",

  "페르소나": "persona",
  "페르소나5": "persona 5",
  "페르소나 5": "persona 5",

  "드퀘": "dragon quest",
  "드래곤퀘스트": "dragon quest",
  "드래곤 퀘스트": "dragon quest",

  "니어": "nier",
  "니어오토마타": "nier automata",
  "니어 오토마타": "nier automata",

  "스타듀": "stardew valley",
  "스타듀밸리": "stardew valley",
  "스타듀 밸리": "stardew valley",

  "할나": "hollow knight",
  "할로우나이트": "hollow knight",
  "할로우 나이트": "hollow knight",

  "하데스": "hades",
  "데드셀": "dead cells",
  "컵헤드": "cuphead",
  "언더테일": "undertale",
  "림월드": "rimworld",
  "발헤임": "valheim",
  "테라리아": "terraria",
  "팩토리오": "factorio",
  "슬더스": "slay the spire",
  "노맨즈": "no man's sky",
  "노맨즈스카이": "no man's sky",
  "노맨즈 스카이": "no man's sky",

  "마크": "minecraft",
  "마인크래프트": "minecraft",

  "팰월드": "palworld",
  "러스트": "rust",
  "아크": "ark survival evolved",
  "서브노티카": "subnautica",

  "피파": "ea sports fc",
  "fc24": "ea sports fc 24",
  "fc 24": "ea sports fc 24",
  "위닝": "efootball",

  "포르자": "forza horizon",
  "그란투리스모": "gran turismo",
  "니드포스피드": "need for speed",
  "니드 포 스피드": "need for speed",

  "왕눈이": "zelda tears of the kingdom",
  "사펑2077": "cyberpunk 2077",
  "싸펑2077": "cyberpunk 2077"
});

function normalizeAliasKey(value) {
  if (typeof value !== "string") {
    return "";
  }

  return value
    .normalize("NFKC")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactAliasKey(value) {
  return normalizeAliasKey(value).replace(/\s+/g, "");
}

function createAliasLookupVariants(value) {
  const normalized = normalizeAliasKey(value);
  const compact = compactAliasKey(value);

  return [...new Set([normalized, compact].filter(Boolean))];
}

module.exports = {
  SEARCH_ALIAS_MAP,
  normalizeAliasKey,
  compactAliasKey,
  createAliasLookupVariants
};
