// HomeClip i18n: English + Bahasa Indonesia. Resolution order:
//   in-app setting ("en"/"id") → platform locale → device language → English.
// Language codes are "en" and "id" only; genres and countries are stored in
// the catalog as stable keys and labelled through this module.

const STRINGS = {
  en: {
    'tab.home': 'Home',
    'tab.discover': 'Discover',
    'tab.mylist': 'My List',
    'tab.profile': 'Profile',

    'common.back': 'Back',
    'common.retry': 'Retry',
    'common.loading': 'Loading',
    'common.errorTitle': 'Something went wrong',
    'common.errorBody': 'Loading failed. Other parts of the app still work.',
    'common.remove': 'Remove',
    'common.saved': 'Settings saved',

    'time.min': 'min',

    'home.search': 'Search dramas',
    'home.trending': 'Trending Now',
    'home.new': 'New Episodes',
    'home.top10': 'Top 10',
    'home.continue': 'Continue Watching',
    'home.browseGenres': 'Browse by genre',

    'search.title': 'Search',
    'search.empty': 'No dramas found.',
    'search.none': 'No matches',
    'search.noneBody': 'Try a different title, or check the spelling.',
    'search.browse': 'Browse dramas',

    'discover.title': 'Discover',
    'discover.genre': 'Genre',
    'discover.country': 'Country',
    'discover.year': 'Year',
    'discover.sort': 'Sort',
    'discover.sort.popularity': 'Popularity',
    'discover.sort.newest': 'Newest',
    'discover.all': 'All',
    'discover.results': '{n} dramas',
    'discover.resultsOne': '{n} drama',
    'discover.empty': 'No dramas match these filters.',
    'discover.clear': 'Clear filters',
    'discover.loadMore': 'Load more',

    'detail.cast': 'Cast',
    'detail.synopsis': 'Synopsis',
    'detail.episodes': 'Episodes',
    'detail.showMore': 'Show more',
    'detail.showLess': 'Show less',
    'detail.play': 'Play',
    'detail.resume': 'Continue EP {n}',
    'detail.add': 'Add to My List',
    'detail.added': 'In My List',
    'detail.episode': 'Episode {n}',
    'detail.notFound': 'This drama is not in the catalog.',

    'mylist.title': 'My List',
    'mylist.tab.list': 'My List',
    'mylist.tab.history': 'History',
    'mylist.empty': 'Your list is empty. Add dramas from Discover or Home.',
    'mylist.browse': 'Discover dramas',
    'mylist.remove': 'Remove',
    'history.empty': 'You have not watched anything yet.',
    'history.remove': 'Remove from history',
    'history.continue': 'Continue',
    'history.epShort': 'EP {n}',

    'profile.title': 'Profile',
    'profile.member': 'Homeroom member',
    'profile.guest': 'Signed-out visitor',
    'profile.guestBody': 'Make an account to save your list, history and settings.',
    'profile.makeAccount': 'Make an account',
    'profile.settings': 'Settings',
    'profile.language': 'Language',
    'profile.langAuto': 'Auto',
    'profile.theme': 'Theme',
    'profile.themeAuto': 'Auto',
    'profile.theme.light': 'Light',
    'profile.theme.dark': 'Dark',
    'profile.notifications': 'Notifications',
    'profile.notificationsDesc': 'New episode alerts (demo setting)',
    'profile.about': 'About',
    'profile.aboutBody': 'HomeClip Phase 1. Every drama is original sample content with placeholder posters and sample video.',

    'player.play': 'Play',
    'player.pause': 'Pause',
    'player.next': 'Next episode',
    'player.episodes': 'Episodes',
    'player.speed': 'Speed',
    'player.subtitles': 'Subtitles',
    'player.subOff': 'Off',
    'player.fullscreen': 'Fullscreen',
    'player.exitFullscreen': 'Exit fullscreen',
    'player.resumeFrom': 'Resuming from {t}',
    'player.error': 'Video failed to load. Check your connection and try again.',
    'player.ended': 'Episode finished',
    'player.watchAgain': 'Watch again',
    'player.lastEp': 'This is the last episode.',

    'demo.note': 'Staging demo',

    'genres.romance': 'Romance',
    'genres.thriller': 'Thriller',
    'genres.fantasy': 'Fantasy',
    'genres.comedy': 'Comedy',
    'genres.historical': 'Historical',
    'genres.action': 'Action',
  },

  id: {
    'tab.home': 'Beranda',
    'tab.discover': 'Jelajahi',
    'tab.mylist': 'Daftar Saya',
    'tab.profile': 'Profil',

    'common.back': 'Kembali',
    'common.retry': 'Coba lagi',
    'common.loading': 'Memuat',
    'common.errorTitle': 'Terjadi kesalahan',
    'common.errorBody': 'Pemuatan gagal. Bagian lain aplikasi tetap berfungsi.',
    'common.remove': 'Hapus',
    'common.saved': 'Pengaturan disimpan',

    'time.min': 'mnt',

    'home.search': 'Cari drama',
    'home.trending': 'Sedang Tren',
    'home.new': 'Episode Baru',
    'home.top10': '10 Besar',
    'home.continue': 'Lanjut Tonton',
    'home.browseGenres': 'Jelajahi per genre',

    'search.title': 'Cari',
    'search.empty': 'Tidak ada drama ditemukan.',
    'search.none': 'Tidak ada hasil',
    'search.noneBody': 'Coba judul lain, atau periksa ejaannya.',
    'search.browse': 'Jelajahi drama',

    'discover.title': 'Jelajahi',
    'discover.genre': 'Genre',
    'discover.country': 'Negara',
    'discover.year': 'Tahun',
    'discover.sort': 'Urutkan',
    'discover.sort.popularity': 'Populer',
    'discover.sort.newest': 'Terbaru',
    'discover.all': 'Semua',
    'discover.results': '{n} drama',
    'discover.resultsOne': '{n} drama',
    'discover.empty': 'Tidak ada drama yang cocok dengan filter ini.',
    'discover.clear': 'Hapus filter',
    'discover.loadMore': 'Muat lebih banyak',

    'detail.cast': 'Pemain',
    'detail.synopsis': 'Sinopsis',
    'detail.episodes': 'Episode',
    'detail.showMore': 'Tampilkan lebih banyak',
    'detail.showLess': 'Tampilkan lebih sedikit',
    'detail.play': 'Putar',
    'detail.resume': 'Lanjut EP {n}',
    'detail.add': 'Tambah ke Daftar Saya',
    'detail.added': 'Ada di Daftar Saya',
    'detail.episode': 'Episode {n}',
    'detail.notFound': 'Drama ini tidak ada dalam katalog.',

    'mylist.title': 'Daftar Saya',
    'mylist.tab.list': 'Daftar Saya',
    'mylist.tab.history': 'Riwayat',
    'mylist.empty': 'Daftarmu masih kosong. Tambahkan drama dari Jelajahi atau Beranda.',
    'mylist.browse': 'Jelajahi drama',
    'mylist.remove': 'Hapus',
    'history.empty': 'Kamu belum menonton apa pun.',
    'history.remove': 'Hapus dari riwayat',
    'history.continue': 'Lanjutkan',
    'history.epShort': 'EP {n}',

    'profile.title': 'Profil',
    'profile.member': 'Anggota Homeroom',
    'profile.guest': 'Pengunjung tanpa akun',
    'profile.guestBody': 'Buat akun untuk menyimpan daftar, riwayat, dan pengaturanmu.',
    'profile.makeAccount': 'Buat akun',
    'profile.settings': 'Pengaturan',
    'profile.language': 'Bahasa',
    'profile.langAuto': 'Otomatis',
    'profile.theme': 'Tema',
    'profile.themeAuto': 'Otomatis',
    'profile.theme.light': 'Terang',
    'profile.theme.dark': 'Gelap',
    'profile.notifications': 'Notifikasi',
    'profile.notificationsDesc': 'Pemberitahuan episode baru (pengaturan demo)',
    'profile.about': 'Tentang',
    'profile.aboutBody': 'HomeClip Fase 1. Semua drama adalah konten contoh asli dengan poster placeholder dan video contoh.',

    'player.play': 'Putar',
    'player.pause': 'Jeda',
    'player.next': 'Episode berikutnya',
    'player.episodes': 'Episode',
    'player.speed': 'Kecepatan',
    'player.subtitles': 'Takarir',
    'player.subOff': 'Mati',
    'player.fullscreen': 'Layar penuh',
    'player.exitFullscreen': 'Keluar layar penuh',
    'player.resumeFrom': 'Melanjutkan dari {t}',
    'player.error': 'Video gagal dimuat. Periksa koneksi dan coba lagi.',
    'player.ended': 'Episode selesai',
    'player.watchAgain': 'Tonton lagi',
    'player.lastEp': 'Ini episode terakhir.',

    'demo.note': 'Demo staging',

    'genres.romance': 'Romansa',
    'genres.thriller': 'Thriller',
    'genres.fantasy': 'Fantasi',
    'genres.comedy': 'Komedi',
    'genres.historical': 'Sejarah',
    'genres.action': 'Aksi',
  },
};

export const GENRES = ['romance', 'thriller', 'fantasy', 'comedy', 'historical', 'action'];
export const COUNTRIES = ['kr', 'jp', 'cn', 'th', 'id', 'my', 'ph', 'tr', 'in', 'uk', 'sg'];

const COUNTRY_LABELS = {
  en: {
    kr: 'South Korea', jp: 'Japan', cn: 'China', th: 'Thailand', id: 'Indonesia',
    my: 'Malaysia', ph: 'Philippines', tr: 'Turkey', in: 'India', uk: 'United Kingdom', sg: 'Singapore',
  },
  id: {
    kr: 'Korea Selatan', jp: 'Jepang', cn: 'Tiongkok', th: 'Thailand', id: 'Indonesia',
    my: 'Malaysia', ph: 'Filipina', tr: 'Turki', in: 'India', uk: 'Inggris', sg: 'Singapura',
  },
};

let lang = 'en';

export function initLang(settingsLang, platformLocale, deviceLocale) {
  let resolved = 'en';
  if (settingsLang === 'en' || settingsLang === 'id') resolved = settingsLang;
  else {
    const candidates = [platformLocale, deviceLocale];
    for (const c of candidates) {
      if (c && typeof c === 'string' && c.toLowerCase().startsWith('id')) { resolved = 'id'; break; }
    }
  }
  lang = resolved;
  return lang;
}

export function getLang() {
  return lang;
}

export function setLang(next) {
  if (STRINGS[next]) lang = next;
}

export function t(key, vars) {
  let s = (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
  if (vars) {
    for (const k in vars) s = s.replace('{' + k + '}', String(vars[k]));
  }
  return s;
}

export function genreLabel(key) {
  return t('genres.' + key);
}

// A count label with a singular form ("1 drama" / "{n} dramas"); Indonesian
// does not pluralize, so both keys read the same there.
export function countLabel(n) {
  return t(n === 1 ? 'discover.resultsOne' : 'discover.results', { n });
}

export function countryLabel(key) {
  return (COUNTRY_LABELS[lang] && COUNTRY_LABELS[lang][key]) || key;
}
