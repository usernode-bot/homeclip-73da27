// The one-time boot import's curated list (see importCatalogOnce in
// server.js). Order is editorial weight: the first five fill the Home
// banner and `trending` feeds the Trending Now row; popularity descends
// down the list. Nothing shown to a viewer is stored here — no ids, URLs
// or synopses: every record's metadata and artwork are matched and
// verified against the provider (TMDB) at import time, through the same
// verified writer the Posters studio uses. The mix is deliberately
// family-friendly (slice of life, family, school, workplace, light
// romance); if an entry is ever swapped, keep that mix.
module.exports.CATALOG_IMPORT = [
  { title: 'Reply 1988', original: '응답하라 1988', year: 2015, country: 'kr', featured: 1, trending: true },
  { title: 'Go Ahead', original: '以家人之名', year: 2020, country: 'cn', featured: 2, trending: true },
  { title: 'Hospital Playlist', original: '슬기로운 의사생활', year: 2020, country: 'kr', featured: 3, trending: true },
  { title: 'Meet Yourself', original: '去有风的地方', year: 2023, country: 'cn', featured: 4, trending: true },
  { title: 'Extraordinary Attorney Woo', original: '이상한 변호사 우영우', year: 2022, country: 'kr', featured: 5, trending: true },
  { title: 'A Love So Beautiful', original: '致我们单纯的小美好', year: 2017, country: 'cn', trending: true },
  { title: 'The Story of Ming Lan', original: '知否？知否？应是绿肥红瘦', year: 2018, country: 'cn', trending: true },
  { title: 'A Little Reunion', original: '小欢喜', year: 2019, country: 'cn', trending: true },
  { title: 'Hometown Cha-Cha-Cha', original: '갯마을 차차차', year: 2021, country: 'kr' },
  { title: 'When I Fly Towards You', original: '当我飞奔向你', year: 2023, country: 'cn' },
  { title: 'Like a Flowing River', original: '大江大河', year: 2018, country: 'cn' },
  { title: 'Put Your Head on My Shoulder', original: '致我们暖暖的小时光', year: 2019, country: 'cn' },
  { title: 'Welcome to Samdal-ri', original: '웰컴투 삼달리', year: 2023, country: 'kr' },
  { title: 'Our Beloved Summer', original: '그 해 우리는', year: 2021, country: 'kr' },
  { title: 'Twinkling Watermelon', original: '반짝이는 워터멜론', year: 2023, country: 'kr' },
  { title: 'Hidden Love', original: '偷偷藏不住', year: 2023, country: 'cn' },
];