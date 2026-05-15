export const BASE_URL = 'https://anikototv.to';

export const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  Connection: 'keep-alive',
  'Cache-Control': 'no-cache',
  Referer: 'https://anikototv.to/',
};

/** Cache TTL in seconds */
export const CACHE_TTL = {
  HOME: 60 * 5,       // 5 minutes
  ANIME: 60 * 30,     // 30 minutes
  EPISODE: 60 * 10,   // 10 minutes
  SEARCH: 60 * 2,     // 2 minutes
  FILTER: 60 * 5,     // 5 minutes
  SCHEDULE: 60 * 60,  // 1 hour
};

export const FILTER_OPTIONS = {
  genres: [
    "action", "adventure", "cars", "comedy", "dementia", "demons", "drama", "ecchi", "fantasy", "game",
    "harem", "historical", "horror", "isekai", "josei", "kids", "magic", "martial-arts", "mecha", "military",
    "music", "mystery", "parody", "police", "psychological", "romance", "samurai", "school", "sci-fi", "seinen",
    "shoujo", "shoujo-ai", "shounen", "shounen-ai", "slice-of-life", "space", "sports", "super-power", "supernatural", "thriller",
    "unknown", "vampire"
  ],
  years: ["2026", "2025", "2024", "2023", "2022", "2021", "2020", "2019", "2018", "2017", "2016", "2015", "2014", "2013", "2012", "2011", "2010", "2009", "2008", "2007", "2006", "2005", "2004", "2003", "2002", "2001", "2000", "1999"],
  types: ["tv", "movie", "ova", "ona", "special", "music"],
  seasons: ["spring", "summer", "fall", "winter"],
  statuses: ["currently-airing", "finished-airing", "not-yet-aired"],
  sorts: ["default", "recently-added", "recently-updated", "score", "name-a-z", "released-date", "most-watched"]
};
