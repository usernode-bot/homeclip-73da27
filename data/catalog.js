// HomeClip Phase 1 mock catalog — 30 ORIGINAL sample dramas.
// Every title, synopsis, character and cast name here is invented for this
// app. No real show, poster artwork or licensed video is used: episode video
// points at one of six committed, same-origin sample clips in public/sample/
// (trims of the Blender Foundation's CC BY open movies, each committed as
// .webm (VP9/Opus) and .mp4 (H.264/AAC) so a browser without H.264 still
// decodes them). URLs are extensionless; the player appends the extensions
// and offers both sources, letting the browser pick a codec. Drama 1
// additionally demonstrates the HLS path: a real .m3u8 test stream with a
// same-origin fallback clip.

const VIDEO_BASE = '';
const VIDEO_POOL = [
  '/sample/bunny',     // Big Buck Bunny
  '/sample/sintel',    // Sintel
  '/sample/elephants', // Elephants Dream
  '/sample/tears',     // Tears of Steel
  '/sample/cosmos',    // Cosmos Laundromat
  '/sample/spring',    // Spring
];

// Drama 1 exercises the HLS path end to end: every episode points at the
// mux demo stream (the platform's proven HLS fixture, also used by the
// tracker demo), with the bunny clip as the same-origin MP4/WebM fallback.
const HLS_URL = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const HLS_FALLBACK = '/sample/bunny';

// D = drama helper: keeps the catalog below readable.
let D = (id, title, year, country, genres, rating, popularity, featured, eps, cast, synopsis_en, synopsis_id) =>
  ({ id, title, year, country, genres, rating, popularity, featured, eps, cast, synopsis_en, synopsis_id });

const DRAMAS = [
  D(1, 'Paper Lanterns at Dusk', 2024, 'kr', ['romance'], 8.4, 97, 1, 10,
    ['Ha Soo-jin', 'Moon Dae-hyun', 'Park Yerim', 'Cho Seung-min'],
    'A letter carrier in an old Seoul quarter starts answering the unanswered mail she delivers, and one reply keeps coming back signed by someone who died two winters ago. Falling for the address, not the person, was never part of the route.',
    'Seorang kurir surat di kota tua Seoul mulai membalas surat-surat yang tak pernah dijawab, dan satu balasan terus kembali, ditandatangani orang yang meninggal dua musim dingin lalu. Jatuh cinta pada alamat, bukan orangnya, bukan bagian dari rutenya.'),
  D(2, 'The Ninth Harbor', 2023, 'jp', ['thriller'], 8.1, 91, 3, 9,
    ['Kenji Arata', 'Mio Fukunaga', 'Rin Takamura', 'Sora Ibuki'],
    'A port-city night auditor finds the same stranger registered in nine different hotels on nine different nights, always checking in under his own name. When the ninth harbor burns, his handwriting is on the guest book.',
    'Seorang auditor malam di kota pelabuhan menemukan orang asing yang sama tercatat di sembilan hotel berbeda pada sembilan malam berbeda, selalu mendaftar dengan namanya sendiri. Saat pelabuhan kesembilan terbakar, tulisan tangannya ada di buku tamu.'),
  D(3, 'Salt and Monsoon', 2025, 'id', ['romance'], 7.9, 88, 2, 10,
    ['Maya Lindawati', 'Rangga Prasetya', 'Sari Utami', 'Bagus Wirawan'],
    "A salt farmer's daughter and a city engineer measuring her coastline for a seawall spend one monsoon arguing about where the water should go. By the last high tide, neither of them is defending the same ground.",
    'Putri petani garam dan seorang insinyur kota yang mengukur garis pantainya untuk tanggul menghabiskan satu musim hujan berdebat tentang ke mana air harus mengalir. Di pasang terakhir, tak satu pun dari mereka lagi membela tanah yang sama.'),
  D(4, 'The Glass Orchard', 2024, 'cn', ['fantasy'], 8.6, 95, 4, 12,
    ['Lin Wanqing', 'Zhao Yueshan', 'Mei Rulan', 'Gu Chengyu'],
    "In a valley where every tree grows inside glass to keep its fruit honest, the youngest gardener finds a branch that ripens only when she lies. The empire's court wants it; the orchard wants her to keep talking.",
    'Di lembah tempat setiap pohon tumbuh di dalam kaca agar buahnya jujur, taman muda termuda menemukan dahan yang hanya matang saat ia berbohong. Istana kekaisaran menginginkannya; kebun buah ingin ia terus berbicara.'),
  D(5, 'Midnight in Senopati', 2024, 'id', ['thriller'], 7.5, 80, null, 8,
    ['Nadia Kirana', 'Bagus Wirawan', 'Rangga Prasetya', 'Maya Lindawati'],
    "A ride-hailing driver's last passenger of the night asks him to follow a car that is not there, and pays triple to be believed. By dawn, five drivers have vanished from the same dispatch group.",
    'Pengemudi ojek daring, dengan penumpang terakhir malam itu, diminta mengikuti mobil yang tak ada, dan membayar tiga kali lipat agar dipercaya. Menjelang pagi, lima pengemudi menghilang dari grup dispatch yang sama.'),
  D(6, 'Crown of Paper Birds', 2022, 'cn', ['historical'], 8.8, 93, 5, 12,
    ['Mei Rulan', 'Gu Chengyu', 'Lin Wanqing', 'Zhao Yueshan'],
    "An empress who cannot read folds her decrees into paper birds and lets the wind choose which province hears them first. Her ministers call it madness; the provinces call it the fairest law they have known.",
    'Seorang permaisuri yang tak bisa membaca melipat dekritnya menjadi burung kertas dan membiarkan angin memilih provinsi mana yang mendengarnya lebih dulu. Menterinya menyebutnya kegilaan; provinsi-provinsi menyebutnya hukum paling adil yang mereka kenal.'),
  D(7, 'Signal Lost', 2025, 'kr', ['thriller'], 8.2, 90, null, 10,
    ['Park Yerim', 'Cho Seung-min', 'Ha Soo-jin', 'Moon Dae-hyun'],
    'A mountain rescue dispatcher keeps receiving distress calls from a ridge her team closed off four years ago, always in her missing partner’s voice. The calls are getting closer to the summit, and to tonight.',
    'Seorang dispatcher penyelamat gunung terus menerima panggilan darurat dari punggung bukit yang timnya tutup empat tahun lalu, selalu dengan suara mitranya yang hilang. Panggilan itu makin dekat ke puncak, dan ke malam ini.'),
  D(8, "The Cartographer's Daughter", 2023, 'uk', ['historical'], 8.0, 76, null, 9,
    ['Elin Marsh', 'Toby Whitfield', 'Maeve Okafor', 'Jonah Reid'],
    "When her father's maps start rearranging the coastline of England by a few miles each week, a mapmaker's daughter inherits the one atlas he never let her open. The country it shows has never been surveyed.",
    'Saat peta ayahnya mulai menggeser garis pantai Inggris beberapa mil setiap minggu, putri pembuat peta mewarisi satu atlas yang tak pernah boleh ia buka. Negara yang ditunjukkan atlas itu tak pernah dipetakan.'),
  D(9, 'Cinnamon and Thunder', 2025, 'id', ['comedy'], 7.3, 71, null, 8,
    ['Sari Utami', 'Bagus Wirawan', 'Nadia Kirana', 'Maya Lindawati'],
    "A warung owner who cannot stand noise inherits her late father's gamelan and a bandmate who only plays during storms. The neighborhood association gives them one month to prove it is music.",
    'Pemilik warung yang benci gaduh mewarisi gamelan mendiang ayahnya dan seorang rekan band yang hanya main saat badai. Pengurus RT memberi mereka satu bulan untuk membuktikan bahwa itu musik.'),
  D(10, 'Kilat Senja', 2025, 'id', ['action'], 7.2, 74, null, 8,
    ['Rangga Prasetya', 'Maya Lindawati', 'Bagus Wirawan', 'Nadia Kirana'],
    'A retired street racer teaching his niece to drive an angkot discovers her routes are the same ones his old crew used to run from the law. The city remembers faster than he does.',
    'Pembalap jalanan pensiunan yang mengajari keponakannya menyetir angkot menemukan rutenya sama dengan jalur yang dulu ia lari dari polisi. Kotanya lebih cepat ingat daripada dirinya.'),
  D(11, 'Eleven Letters from Batavia', 2023, 'id', ['historical'], 8.2, 82, null, 10,
    ['Sari Utami', 'Rangga Prasetya', 'Maya Lindawati', 'Bagus Wirawan'],
    'Eleven letters a scribe wrote home in 1926 arrive in Jakarta in 2023, each describing a city that modern maps say was never built. His great-granddaughter starts replying.',
    'Sebelas surat yang ditulis seorang juru tulis pada 1926 tiba di Jakarta pada 2023, masing-masing menggambarkan kota yang menurut peta modern tak pernah dibangun. Cicitnya mulai membalas.'),
  D(12, 'Five Days in Ubud', 2024, 'id', ['comedy'], 7.4, 69, null, 8,
    ['Nadia Kirana', 'Sari Utami', 'Rangga Prasetya', 'Bagus Wirawan'],
    "Four colleagues with one shared hotel room and five days of retreat must agree on everything from the itinerary to whose snore is worse. The resort's monkeys have already picked sides.",
    'Empat rekan kerja dengan satu kamar hotel dan lima hari retret harus sepakat tentang segalanya, dari itinerary sampai siapa yang lebih keruh mendornornya. Monyet-monyet resor sudah memilih pihak.'),
  D(13, 'Ashes of the Lagoon', 2022, 'th', ['thriller'], 7.8, 77, null, 9,
    ['Ploy Sirikan', 'Natt Trirat', 'Anong Chaiya', 'Vim Suriya'],
    "A fisheries inspector counting fish in a dying lagoon finds boats that return heavier than they left and crews who will not say why. The village burns its own records before she can read them.",
    'Inspektur perikanan yang menghitung ikan di laguna yang sekarat menemukan perahu yang kembali lebih berat daripada saat berangkat, dengan awak yang tak mau bicara. Desanya membakar catatannya sendiri sebelum sempat ia baca.'),
  D(14, 'The Quiet Harbour Line', 2021, 'kr', ['romance'], 7.6, 65, null, 9,
    ['Cho Seung-min', 'Ha Soo-jin', 'Park Yerim', 'Moon Dae-hyun'],
    'The last ferry dispatcher of a shrinking island town falls for a voice on the radio band who only calls when the fog is too thick to sail. Technically, she is not supposed to exist.',
    'Dispatcher feri terakhir di kota pulau yang menyusut jatuh cinta pada suara di frekuensi radio yang hanya menelepon saat kabut terlalu tebal untuk berlayar. Secara teknis, suara itu tak seharusnya ada.'),
  D(15, 'Whisper of the Sago Grove', 2024, 'my', ['fantasy'], 7.7, 72, null, 10,
    ['Zulaikha Rahim', 'Ariff Mansor', 'Chong Wei Ling', 'Danish Osman'],
    'Every seventh child born under the sago grove hears it whisper a debt the family owes the river. A midwife’s apprentice decides, for once, to answer back.',
    'Setiap anak ketujuh yang lahir di bawah rumpun sagu mendengarnya berbisik tentang utang yang keluarganya pinjamkan pada sungai. Seorang magang bidan memutuskan, untuk pertama kalinya, untuk membalas.'),
  D(16, 'Neon Monsoon', 2025, 'in', ['action'], 7.9, 89, null, 10,
    ['Aarav Menon', 'Ira Chatterjee', 'Kabir Rathore', 'Tara Pillai'],
    'A courier who carries city contraband through flooded monsoon streets takes one package too ordinary to be worth her life. The whole underworld agrees with her, which is the problem.',
    'Kurir yang mengantar barang gelap di jalanan Mumbai yang banjir menerima satu paket yang terlalu biasa untuk menghabisi nyawanya. Seluruh dunia bawah tanah sepakat dengan dia, dan itulah masalahnya.'),
  D(17, 'The Last Ferrymaster', 2021, 'th', ['historical'], 8.3, 78, null, 9,
    ['Natt Trirat', 'Ploy Sirikan', 'Vim Suriya', 'Anong Chaiya'],
    "The last ferryman of a river the new bridge made useless keeps crossing anyway, carrying the dead's unfinished errands for a coin no mint has issued. The bridge is younger than he looks.",
    'Tukang perahu terakhir di sungai yang dijadikan sia-sia oleh jembatan baru tetap menyeberang, mengantar urusan yang belum selesai dari orang mati demi koin yang tak pernah dicetak. Jembatannya lebih muda daripada wajahnya.'),
  D(18, 'Sakura Static', 2024, 'jp', ['romance'], 8.1, 86, null, 10,
    ['Mio Fukunaga', 'Kenji Arata', 'Sora Ibuki', 'Rin Takamura'],
    'A radio engineer fixing the static in Tokyo’s oldest broadcast tower finds a love confession recorded in 1974 that only plays during cherry-blossom season. She starts answering on air.',
    'Insinyur radio yang memperbaiki derau di menara siaran tertua Tokyo menemukan pengakuan cinta yang direkam pada 1974 dan hanya terdengar saat musim sakura. Ia mulai menjawab lewat siaran.'),
  D(19, 'The Parallel Aunties', 2024, 'ph', ['comedy'], 7.5, 70, null, 8,
    ['Liwayway Cruz', 'Marco dela Peña', 'Rosa Villaflor', 'Jun Bautista'],
    'Two aunts discover they have been attending the same family gatherings for a decade, one invited and one not, and neither will say who let it go on. The clan’s next reunion has a seating problem.',
    'Dua bibi menemukan mereka telah menghadiri acara keluarga yang sama selama sepuluh tahun, satu diundang dan satu tidak, dan tak satu pun mau bilang siapa yang membiarkannya. Reuni klan berikutnya punya masalah tempat duduk.'),
  D(20, 'Istanbul Gray', 2023, 'tr', ['thriller'], 8.0, 79, null, 9,
    ['Deniz Karaca', 'Elif Sönmez', 'Kerem Aydın', 'Nil Aksu'],
    'A colour-blind painter hired to restore a mosque dome realizes the restorer before him matched every pigment but one, and painted the difference into the sky. The imam has waited thirty years for someone to notice.',
    'Pelukis buta warna yang direkrut memulihkan kubah masjid menyadari pemulih sebelumnya mencocokkan semua pigmen kecuali satu, dan melukis perbedaannya ke langit. Imam sudah menunggu tiga puluh tahun agar ada yang menyadari.'),
  D(21, 'Little Empires of Sunda', 2022, 'id', ['historical'], 7.8, 63, null, 8,
    ['Bagus Wirawan', 'Sari Utami', 'Nadia Kirana', 'Rangga Prasetya'],
    'Three village chiefs in old Sunda each keep the same treaty in their family shrine, and each copy names a different village as its rightful heir. A drought forces all three shrines open in the same week.',
    'Tiga kepala desa di Sunda kuno masing-masing menyimpan perjanjian yang sama di pamali keluarganya, dan tiap salinan menamai desa berbeda sebagai pewaris sahnya. Kekeringan memaksa ketiga pamali terbuka di minggu yang sama.'),
  D(22, "The Comet Chasers' Club", 2023, 'jp', ['fantasy'], 8.2, 84, null, 11,
    ['Sora Ibuki', 'Rin Takamura', 'Kenji Arata', 'Mio Fukunaga'],
    'A night-school astronomy club that has met every Thursday for sixty years finally gets its comet, which arrives sixty years late and grants one wish per member. Most of them wish for more Thursdays.',
    'Klub astronomi sekolah malam yang bertemu setiap Kamis selama enam puluh tahun akhirnya mendapat kometnya, yang datang enam puluh tahun terlambat dan mengabulkan satu permintaan per anggota. Kebanyakan dari mereka meminta lebih banyak hari Kamis.'),
  D(23, 'Nine Nights of Rindu', 2024, 'id', ['romance'], 8.0, 87, null, 10,
    ['Maya Lindawati', 'Nadia Kirana', 'Rangga Prasetya', 'Bagus Wirawan'],
    "A wedding singer who only sings other people's promises agrees to perform nine nights straight for a couple she has never met. On night five, the groom asks her to stop singing his bride's favourite song.",
    'Penyanyi pernikahan yang hanya menyanyikan janji orang lain setuju tampil sembilan malam berturut-turut untuk pasangan yang tak pernah ia temui. Di malam kelima, mempelai pria memintanya berhenti menyanyikan lagu favorit pengantin wanita.'),
  D(24, 'Stormproof', 2022, 'kr', ['action'], 7.4, 66, null, 8,
    ['Moon Dae-hyun', 'Cho Seung-min', 'Park Yerim', 'Ha Soo-jin'],
    "A typhoon-proofing crew that braces towers before every storm finds one building the wind always refuses, and an owner who pays them never to speak of it. The next typhoon has a name, and it is the owner's.",
    'Kru perkuat gedung anti-topan yang memasang dudukan sebelum setiap badai menemukan satu gedung yang selalu dihindari angin, dan pemiliknya yang membayar mereka agar tak membicarakannya. Topan berikutnya punya nama, dan itu nama pemiliknya.'),
  D(25, 'The Meridian Girls', 2025, 'sg', ['thriller'], 7.6, 75, null, 9,
    ['Priya Nair', 'Wen Jiale', 'Nurul Huda', 'Sean Tan'],
    'Four night-shift girls at a maritime traffic office track a ship that appears on every radar except the one pointing home. The harbour master’s log says the ship arrived in 1987.',
    'Empat gadis shift malam di kantor lalu lintas maritim melacak kapal yang muncul di semua radar kecuali yang mengarah ke rumah. Log kepala pelabuhan menyatakan kapal itu tiba pada 1987.'),
  D(26, 'The Runaway Grandmother', 2023, 'cn', ['comedy'], 8.4, 92, null, 10,
    ['Zhao Yueshan', 'Mei Rulan', 'Gu Chengyu', 'Lin Wanqing'],
    'A grandmother fakes her own disappearance to test which of her six children actually knows her birthday, then sends them a group photo from a town she always refused to visit. None of the children recognize the town; the youngest recognizes the man beside her.',
    'Seorang nenek berpura-pura menghilang untuk menguji mana dari enam anaknya yang benar-benar tahu ulang tahunnya, lalu mengirim foto grup dari kota yang selalu ia tolak datangi. Tak seorang anak pun mengenali kotanya; yang termuda mengenali pria di sampingnya.'),
  D(27, 'Phuket Phantom Line', 2024, 'th', ['action'], 7.1, 62, null, 8,
    ['Vim Suriya', 'Anong Chaiya', 'Natt Trirat', 'Ploy Sirikan'],
    'A bus route decommissioned years ago still runs one departure a night, and a new inspector is assigned to find out who is driving it. Every passenger is someone the route used to leave behind.',
    'Rute bus yang dinonaktifkan bertahun-tahun lalu masih berangkat sekali per malam, dan seorang inspektur baru ditugaskan mencari siapa pengemudinya. Setiap penumpang adalah orang yang dulu tertinggal di rute itu.'),
  D(28, 'The Marble Season', 2022, 'tr', ['romance'], 7.7, 68, null, 9,
    ['Elif Sönmez', 'Deniz Karaca', 'Nil Aksu', 'Kerem Aydın'],
    'An apprentice in a marble-cutting town falls for the quarry singer who is only ever hired for funerals, and learns the town cuts stone the way it says goodbye. Her first commission is his.',
    'Seorang magang di kota pemotong marmer jatuh cinta pada penyanyi tambang yang hanya dipekerjakan untuk pemakaman, dan belajar bahwa kota itu memotong batu seperti mereka berpamitan. Komisi pertamanya adalah miliknya.'),
  D(29, 'Tides of Karang Asti', 2023, 'id', ['fantasy'], 7.6, 67, null, 9,
    ['Sari Utami', 'Nadia Kirana', 'Maya Lindawati', 'Rangga Prasetya'],
    'On an island where the tide keeps everything anyone ever lost, a salvager’s apprentice is hired to raise a ship the tide has been protecting for forty years. The tide sends back an invoice.',
    'Di pulau tempat pasang menyimpan segala yang pernah hilang, magang penyelam dipekerjakan mengangkat kapal yang dijaga pasang selama empat puluh tahun. Pasang itu mengirimkan tagihan.'),
  D(30, 'The Sunday Serial', 2025, 'uk', ['comedy'], 7.9, 81, null, 8,
    ['Toby Whitfield', 'Elin Marsh', 'Jonah Reid', 'Maeve Okafor'],
    'A small village discovers its weekly soap opera has been quietly using their real names for thirty years, and only now does a plot match a murder nobody solved. Everyone starts watching; the writer stops.',
    'Sebuah desa kecil menemukan sinetron mingguannya diam-diam memakai nama asli mereka selama tiga puluh tahun, dan baru sekarang sebuah alur cocok dengan pembunuhan yang tak pernah terpecahkan. Semua orang mulai menonton; penulisnya berhenti.'),
];

// Episodes are generated deterministically per drama: 8-12 episodes, 38-52
// display minutes each, and a sample video from the pool. The pool stride
// over i must be coprime with the pool length (6), so a drama's episodes
// rotate through every clip rather than a short cycle — the H.264-less
// check browser plays them all, and "continue from last minute" is
// meaningful on clips this long. The five featured dramas (ids 1-4, 6) mark
// their final two episodes VIP: enough to meet the paywall on the popular
// screens without gating everything.
const VIP_DRAMA_IDS = [1, 2, 3, 4, 6];
function episodesFor(d) {
  const out = [];
  for (let i = 1; i <= d.eps; i++) {
    const ep = {
      num: i,
      durationMin: 38 + ((d.id * 7 + i * 3) % 15),
      videoUrl: VIDEO_BASE + VIDEO_POOL[(d.id * 5 + i) % VIDEO_POOL.length],
      access: (VIP_DRAMA_IDS.includes(d.id) && i > d.eps - 2) ? 'vip' : 'free',
      fallbackUrl: null,
    };
    if (d.id === 1) {
      ep.videoUrl = HLS_URL;
      ep.fallbackUrl = HLS_FALLBACK;
    }
    out.push(ep);
  }
  return out;
}

module.exports = { DRAMAS, episodesFor, VIDEO_BASE, VIDEO_POOL };
