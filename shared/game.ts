// Rules and catalogs of the two game modes (shared by the Worker and documented for the app).
//
// GLOBAL MODE: every accepted run adds the NEW area it encloses to the runner's world map. Nobody can
// steal it. Rankings: world, country, city, friends, club; all time and this month.
//
// COMPETITION MODE (only for club members): 14-day cycles aligned to the week, Europe/Madrid time:
//   - Competition: Friday 00:00 -> Sunday of the following week 23:59 (10 days). The competition map
//     starts empty. It is scored on Monday at 06:00 (runs that started before the end and arrive late
//     still count) and then wiped. Members who didn't run in the previous 14 days don't take part.
//   - Rest: Monday -> Thursday (4 days). Chests spawn around the clubs' cities and every member gets
//     challenges. Both give items (powers, global boosts, cosmetics).

export type Rarity = 'common' | 'rare' | 'epic' | 'legendary';
export const RARITIES: Rarity[] = ['common', 'rare', 'epic', 'legendary'];

export const RARITY_INFO: Record<Rarity, { label: string; color: string; weight: number }> = {
  common: { label: 'Común', color: '#CD7F32', weight: 0.45 },
  rare: { label: 'Raro', color: '#7C8CA1', weight: 0.30 },
  epic: { label: 'Épico', color: '#F59E0B', weight: 0.18 },
  legendary: { label: 'Legendario', color: '#8B5CF6', weight: 0.07 },
};

// ─── Season calendar ─────────────────────────────────────────────────────────

export const SEASON_TIME_ZONE = 'Europe/Madrid';
export const CYCLE_DAYS = 14;
export const COMPETITION_DAYS = 10;
export const REST_DAYS = CYCLE_DAYS - COMPETITION_DAYS;
/** Local date (Europe/Madrid) of the first competition: a Friday. Cycle n starts n*14 days later. */
export const SEASON_ANCHOR_DATE = '2026-11-13';
/** Members can still join a running competition during its first hours. */
export const LATE_JOIN_HOURS = 48;
/**
 * The competition ends on Sunday 23:59, but it is scored this many hours later: runs that started
 * before the end and arrive late (a watch synced on Monday morning) still count.
 */
export const COMPETITION_GRACE_HOURS = 6;
/** Members who didn't run in this many days before a competition don't take part in it. */
export const INACTIVE_DAYS = 14;

// ─── Competition modes ───────────────────────────────────────────────────────

export type CompetitionMode = 'ffa' | 'teams' | 'target' | 'duel';

/** Mode of cycle n is MODE_ROTATION[n % length]; a club that can't play it gets the fallback. */
export const MODE_ROTATION: CompetitionMode[] = ['ffa', 'duel', 'teams', 'target'];

/**
 * Who can still enter a running competition (inactive members who start running, or members who
 * joined the club during its first 48 h):
 *   - none: team against team (Equipos, Duelo, Derbi): the line-ups are fixed when it starts.
 *   - until_first_cut: Eliminación, only before the first cut (the cut plan must add up).
 *   - open: individual and cooperative modes, any time.
 */
export type LateEntry = 'none' | 'until_first_cut' | 'open';

export const MODE_INFO: Record<CompetitionMode, { name: string; emoji: string; description: string; minParticipants: number; lateEntry: LateEntry }> = {
  ffa: {
    name: 'Todos contra todos',
    emoji: '⚔️',
    description: 'Cada miembro del club conquista para sí mismo y puede robar territorio a cualquier compañero. Gana quien tenga más km² al final.',
    minParticipants: 2,
    lateEntry: 'open',
  },
  teams: {
    name: 'Por equipos',
    emoji: '🛡️',
    description: 'El club se divide en dos equipos equilibrados. Solo se roba al equipo rival. Gana el equipo con más km² sumados.',
    minParticipants: 4,
    lateEntry: 'none',
  },
  target: {
    name: 'Objetivo común',
    emoji: '🎯',
    description: 'Todo el club suma para llegar a un objetivo de km² proporcional a sus participantes. Nadie roba a nadie.',
    minParticipants: 1,
    lateEntry: 'open',
  },
  duel: {
    name: 'Duelo de clubes',
    emoji: '🤝',
    description: 'Tu club se enfrenta a otro club de nivel parecido. Cuentan los km² conquistados por vuestros mejores corredores, con el mismo número de corredores por club y un tope por persona.',
    minParticipants: 3,
    lateEntry: 'none',
  },
};

/** "Objetivo común": km² to reach per participant (competition map, no stealing). */
export const TARGET_AREA_PER_PARTICIPANT_M2 = 1_500_000;
/** Duel: area a single runner can add to the club score. */
export const DUEL_PER_RUNNER_CAP_M2 = 3_000_000;
/** Duel: members who ran in the last ACTIVE_WINDOW_DAYS count as "active" for matchmaking and N. */
export const ACTIVE_WINDOW_DAYS = 14;
export const MIN_ACTIVE_FOR_DUEL = 3;
export const ELO_K = 32;
export const ELO_START = 1000;

// ─── Clubs ───────────────────────────────────────────────────────────────────

export const CLUB_MAX_MEMBERS = 50;
export const CLUB_NAME_MIN = 3;
export const CLUB_NAME_MAX = 30;
export const CLUB_SLOGAN_MAX = 80;
export type ClubRole = 'owner' | 'admin' | 'member';
export type ClubVisibility = 'public' | 'private';

export type CrestShape = 'classic' | 'round' | 'hex' | 'diamond' | 'banner';
export type CrestPattern = 'plain' | 'stripes' | 'chevron' | 'diagonal' | 'quartered' | 'cross' | 'stars';

export interface Crest {
  shape: CrestShape;
  pattern: CrestPattern;
  primary: string; // #RRGGBB
  secondary: string; // #RRGGBB
  icon: string; // SF Symbol name from CREST_ICONS
  initials: string; // 0-3 letters
}

/** Crest pieces: free ones can always be used; the others need the cosmetic unlocked by a member. */
export const CREST_SHAPES: Record<CrestShape, { unlock?: string }> = {
  classic: {}, round: {}, hex: {},
  diamond: { unlock: 'crest_shape_diamond' },
  banner: { unlock: 'crest_shape_banner' },
};
export const CREST_PATTERNS: Record<CrestPattern, { unlock?: string }> = {
  plain: {}, stripes: {}, chevron: {}, diagonal: {},
  quartered: { unlock: 'crest_pattern_quartered' },
  cross: { unlock: 'crest_pattern_cross' },
  stars: { unlock: 'crest_pattern_stars' },
};
export const CREST_ICONS: Record<string, { unlock?: string }> = {
  'figure.run': {}, 'flame.fill': {}, 'bolt.fill': {}, 'star.fill': {}, 'leaf.fill': {},
  'mountain.2.fill': {}, 'hare.fill': {}, 'heart.fill': {}, 'sun.max.fill': {}, 'moon.fill': {},
  'pawprint.fill': { unlock: 'crest_icon_pawprint' },
  'bird.fill': { unlock: 'crest_icon_bird' },
  'sparkles': { unlock: 'crest_icon_sparkles' },
  'trophy.fill': { unlock: 'crest_icon_trophy' },
  'crown.fill': { unlock: 'crest_icon_crown' },
};

export const DEFAULT_CREST: Crest = {
  shape: 'classic', pattern: 'plain', primary: '#16A34A', secondary: '#FFFFFF', icon: 'figure.run', initials: '',
};

// ─── Items: powers, global boosts and cosmetics ──────────────────────────────

/** competition: only affects the competition map. global: affects the global ranking (small, capped). */
export type ItemScope = 'competition' | 'global' | 'cosmetic';
export type ItemActivation =
  | 'next_run' // applies to your next run, then it's used
  | 'timed' // active for activeHours after you activate it
  | 'instant' // takes effect when activated
  | 'target' // needs another participant as target
  | 'passive' // works on its own (e.g. streak saver), no activation
  | 'owned'; // cosmetic: unlocked forever

export interface ItemDefinition {
  id: string;
  scope: ItemScope;
  name: string;
  description: string;
  emoji: string;
  rarity: Rarity;
  activation: ItemActivation;
  /** Hours the effect lasts once activated (timed / target items) */
  activeHours?: number;
  /**
   * Hours you have to use it before it expires. Competition items obtained during a rest phase only
   * start counting when the next competition starts. null = never expires.
   */
  unusedTtlHours: number | null;
  /** 'competition': can only be activated while a competition is running. 'any': whenever. */
  usablePhase: 'competition' | 'any';
  category: 'defense' | 'attack' | 'utility' | 'global' | 'cosmetic';
}

const DEFENSE_TTL = 72;
const ATTACK_TTL = 168;

export const ITEMS: Record<string, ItemDefinition> = {
  // Defense (competition): expire sooner
  shield: { id: 'shield', scope: 'competition', name: 'Escudo de Acero', description: 'Nadie puede robarte territorio durante 24 h.', emoji: '🛡️', rarity: 'rare', activation: 'timed', activeHours: 24, unusedTtlHours: DEFENSE_TTL, usablePhase: 'competition', category: 'defense' },
  invisibility: { id: 'invisibility', scope: 'competition', name: 'Capa de Sombras', description: 'Tu territorio es invisible e intocable durante 24 h.', emoji: '👻', rarity: 'legendary', activation: 'timed', activeHours: 24, unusedTtlHours: DEFENSE_TTL, usablePhase: 'competition', category: 'defense' },
  time_bomb: { id: 'time_bomb', scope: 'competition', name: 'Bomba Temporal', description: 'Durante 24 h, quien intente robarte pierde lo que iba a robar.', emoji: '💣', rarity: 'rare', activation: 'timed', activeHours: 24, unusedTtlHours: DEFENSE_TTL, usablePhase: 'competition', category: 'defense' },
  wall: { id: 'wall', scope: 'competition', name: 'Muralla Imparable', description: 'Durante 24 h, cada carrera fortalece el doble tu territorio.', emoji: '🧱', rarity: 'rare', activation: 'timed', activeHours: 24, unusedTtlHours: DEFENSE_TTL, usablePhase: 'competition', category: 'defense' },
  sentinel: { id: 'sentinel', scope: 'competition', name: 'Centinela', description: 'Durante 24 h te avisamos al momento de cada robo.', emoji: '🔔', rarity: 'common', activation: 'timed', activeHours: 24, unusedTtlHours: DEFENSE_TTL, usablePhase: 'competition', category: 'defense' },
  // Attack (competition)
  double_area: { id: 'double_area', scope: 'competition', name: 'Doble Conquista', description: 'Tu siguiente carrera conquista el doble de área.', emoji: '⚡', rarity: 'epic', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  steal_boost: { id: 'steal_boost', scope: 'competition', name: 'Espada Voraz', description: 'Tu siguiente carrera cuenta un 50% más de lo que robas.', emoji: '⚔️', rarity: 'epic', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  magnet: { id: 'magnet', scope: 'competition', name: 'Imán de Tierras', description: 'Tu siguiente carrera abarca un 25% más de área.', emoji: '🧲', rarity: 'rare', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  bulldozer: { id: 'bulldozer', scope: 'competition', name: 'El Arrasador', description: 'Tu siguiente carrera ignora todas las fortalezas rivales.', emoji: '🚜', rarity: 'epic', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  battering_ram: { id: 'battering_ram', scope: 'competition', name: 'Ariete de Guerra', description: 'Tu siguiente carrera rompe tres veces más capas de fortaleza.', emoji: '🪓', rarity: 'legendary', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  sabotage: { id: 'sabotage', scope: 'competition', name: 'Sabotaje', description: 'La siguiente carrera del rival que elijas (en 24 h) conquista un 20% menos.', emoji: '🪤', rarity: 'epic', activation: 'target', activeHours: 24, unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  rally: { id: 'rally', scope: 'competition', name: 'Llamada al Club', description: 'Durante 2 h, todo tu club conquista un 50% más de área.', emoji: '📣', rarity: 'legendary', activation: 'timed', activeHours: 2, unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  head_start: { id: 'head_start', scope: 'competition', name: 'Ventaja Inicial', description: 'Suma 0,1 km² a tu puntuación de esta competición.', emoji: '🚀', rarity: 'rare', activation: 'instant', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'attack' },
  // Utility (competition)
  spy: { id: 'spy', scope: 'competition', name: 'Espía', description: 'Ves la última carrera de un rival de tu competición.', emoji: '🕵️', rarity: 'common', activation: 'target', unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'utility' },
  nickname: { id: 'nickname', scope: 'competition', name: 'Pluma del Troll', description: 'Pon un apodo a un rival de tu competición durante 48 h.', emoji: '✏️', rarity: 'common', activation: 'target', activeHours: 48, unusedTtlHours: ATTACK_TTL, usablePhase: 'competition', category: 'utility' },
  reveal: { id: 'reveal', scope: 'competition', name: 'Faro', description: 'Durante 24 h ves los cofres ocultos del mapa.', emoji: '🔦', rarity: 'common', activation: 'timed', activeHours: 24, unusedTtlHours: ATTACK_TTL, usablePhase: 'any', category: 'utility' },
  // Global boosts: small and capped so the global ranking stays fair
  explorer: { id: 'explorer', scope: 'global', name: 'Explorador', description: 'Tu siguiente carrera suma un 50% extra del área global nueva (máximo 0,5 km² extra).', emoji: '🧭', rarity: 'epic', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'any', category: 'global' },
  wide_trail: { id: 'wide_trail', scope: 'global', name: 'Estela Ancha', description: 'En tu siguiente carrera, también cuenta una franja de 25 m a cada lado del recorrido (útil en idas y vueltas).', emoji: '🛤️', rarity: 'rare', activation: 'next_run', unusedTtlHours: ATTACK_TTL, usablePhase: 'any', category: 'global' },
  streak_saver: { id: 'streak_saver', scope: 'global', name: 'Salvarrachas', description: 'Si un día no corres, tu racha no se pierde. Se usa sola.', emoji: '🔥', rarity: 'common', activation: 'passive', unusedTtlHours: ATTACK_TTL, usablePhase: 'any', category: 'global' },
  // Cosmetics: permanent
  title_pionero: { id: 'title_pionero', scope: 'cosmetic', name: 'Título: Pionero', description: 'Se muestra junto a tu nombre en los rankings.', emoji: '🏳️', rarity: 'common', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  title_incansable: { id: 'title_incansable', scope: 'cosmetic', name: 'Título: Incansable', description: 'Se muestra junto a tu nombre en los rankings.', emoji: '🏃', rarity: 'rare', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  title_cartografo: { id: 'title_cartografo', scope: 'cosmetic', name: 'Título: Cartógrafo', description: 'Se muestra junto a tu nombre en los rankings.', emoji: '🗺️', rarity: 'epic', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  title_leyenda: { id: 'title_leyenda', scope: 'cosmetic', name: 'Título: Leyenda', description: 'Se muestra junto a tu nombre en los rankings.', emoji: '👑', rarity: 'legendary', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_icon_pawprint: { id: 'crest_icon_pawprint', scope: 'cosmetic', name: 'Escudo: Huella', description: 'Icono para el escudo de tu club.', emoji: '🐾', rarity: 'common', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_icon_bird: { id: 'crest_icon_bird', scope: 'cosmetic', name: 'Escudo: Ave', description: 'Icono para el escudo de tu club.', emoji: '🐦', rarity: 'rare', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_icon_sparkles: { id: 'crest_icon_sparkles', scope: 'cosmetic', name: 'Escudo: Destellos', description: 'Icono para el escudo de tu club.', emoji: '✨', rarity: 'rare', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_icon_trophy: { id: 'crest_icon_trophy', scope: 'cosmetic', name: 'Escudo: Trofeo', description: 'Icono para el escudo de tu club.', emoji: '🏆', rarity: 'epic', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_icon_crown: { id: 'crest_icon_crown', scope: 'cosmetic', name: 'Escudo: Corona', description: 'Icono para el escudo de tu club.', emoji: '👑', rarity: 'legendary', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_shape_diamond: { id: 'crest_shape_diamond', scope: 'cosmetic', name: 'Escudo: Forma diamante', description: 'Forma para el escudo de tu club.', emoji: '🔷', rarity: 'rare', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_shape_banner: { id: 'crest_shape_banner', scope: 'cosmetic', name: 'Escudo: Forma estandarte', description: 'Forma para el escudo de tu club.', emoji: '🚩', rarity: 'epic', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_pattern_quartered: { id: 'crest_pattern_quartered', scope: 'cosmetic', name: 'Escudo: Cuartelado', description: 'Fondo para el escudo de tu club.', emoji: '🟫', rarity: 'rare', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_pattern_cross: { id: 'crest_pattern_cross', scope: 'cosmetic', name: 'Escudo: Cruz', description: 'Fondo para el escudo de tu club.', emoji: '✚', rarity: 'epic', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
  crest_pattern_stars: { id: 'crest_pattern_stars', scope: 'cosmetic', name: 'Escudo: Estrellas', description: 'Fondo para el escudo de tu club.', emoji: '🌟', rarity: 'legendary', activation: 'owned', unusedTtlHours: null, usablePhase: 'any', category: 'cosmetic' },
};

/** Items of a scope you can hold unused at the same time; a new one replaces the oldest. */
export const INVENTORY_CAP = 3;

/** Explorer: extra global area = min(newArea * 0.5, cap) */
export const EXPLORER_BONUS_RATIO = 0.5;
export const EXPLORER_BONUS_CAP_M2 = 500_000;
/** Wide trail: metres added on each side of the track */
export const WIDE_TRAIL_METERS = 25;
/** Head start: score bonus in the current competition */
export const HEAD_START_BONUS_M2 = 100_000;

export function itemDefinition(id: string): ItemDefinition | null {
  return ITEMS[id] ?? null;
}

/**
 * Picks the item a chest/reward of `rarity` contains. 60% a competition power, 25% a global boost,
 * 15% a cosmetic the user doesn't own yet (falls back to a power when they own them all).
 * Prefers items of the same rarity, else the closest lower one.
 */
export function pickRewardItem(rarity: Rarity, random: () => number = Math.random, owned: Set<string> = new Set()): string {
  const roll = random();
  const scope: ItemScope = roll < 0.6 ? 'competition' : roll < 0.85 ? 'global' : 'cosmetic';
  const order = [rarity, ...RARITIES.slice(0, RARITIES.indexOf(rarity)).reverse(), ...RARITIES.slice(RARITIES.indexOf(rarity) + 1)];
  const pools: ItemScope[] = scope === 'cosmetic' ? ['cosmetic', 'competition'] : [scope, 'competition'];
  for (const poolScope of pools) {
    for (const r of order) {
      const candidates = Object.values(ITEMS).filter((item) =>
        item.scope === poolScope && item.rarity === r && !(poolScope === 'cosmetic' && owned.has(item.id)),
      );
      if (candidates.length > 0) return candidates[Math.floor(random() * candidates.length) % candidates.length].id;
    }
  }
  return 'magnet';
}

export function pickRarity(random: () => number = Math.random, boost = 0): Rarity {
  // boost shifts probability towards rarer chests (0 = normal)
  let roll = random() * (1 - boost);
  for (const rarity of RARITIES) {
    roll -= RARITY_INFO[rarity].weight;
    if (roll <= 0) return rarity;
  }
  return 'common';
}

// ─── Rest-phase challenges ───────────────────────────────────────────────────

export type ChallengeType = 'early_bird' | 'long_run' | 'club_run' | 'streak3' | 'distance_total' | 'new_ground' | 'fast_5k';

export interface ChallengeDefinition {
  type: ChallengeType;
  title: string;
  description: string;
  emoji: string;
  /** Target in the challenge's unit */
  target: number;
  unit: 'runs' | 'm' | 'days' | 'm2';
  reward: Rarity;
}

export const CHALLENGES: Record<ChallengeType, ChallengeDefinition> = {
  early_bird: { type: 'early_bird', title: 'Madrugador', description: 'Corre al menos 5 km empezando antes de las 9:00.', emoji: '🌅', target: 1, unit: 'runs', reward: 'rare' },
  long_run: { type: 'long_run', title: 'Tirada larga', description: 'Haz una carrera de 10 km o más.', emoji: '🛣️', target: 1, unit: 'runs', reward: 'rare' },
  club_run: { type: 'club_run', title: 'En equipo', description: 'Corre a la vez y por la misma zona que alguien de tu club.', emoji: '🤝', target: 1, unit: 'runs', reward: 'epic' },
  streak3: { type: 'streak3', title: 'Constancia', description: 'Corre 3 días distintos durante el descanso.', emoji: '📅', target: 3, unit: 'days', reward: 'rare' },
  distance_total: { type: 'distance_total', title: 'Kilómetros', description: 'Suma 20 km durante el descanso.', emoji: '📏', target: 20_000, unit: 'm', reward: 'epic' },
  new_ground: { type: 'new_ground', title: 'Tierra nueva', description: 'Conquista 0,1 km² nuevos en el mapa global.', emoji: '🧭', target: 100_000, unit: 'm2', reward: 'rare' },
  fast_5k: { type: 'fast_5k', title: 'A tope', description: 'Corre 5 km o más a menos de 5:30 min/km.', emoji: '💨', target: 1, unit: 'runs', reward: 'epic' },
};

export const CHALLENGES_PER_REST = 3;

// ─── Anti-cheat thresholds ───────────────────────────────────────────────────

export const ANTI_CHEAT = {
  /** Average pace faster than 2:50 min/km is not running */
  maxAvgSpeedKmh: 3600 / 170,
  /** Average pace slower than 12:00 min/km is walking */
  minAvgSpeedKmh: 5,
  /** Runs shorter than this skip the pace checks (GPS noise dominates) */
  minCheckedDistanceM: 1000,
  /** Share of the distance above vehicleSpeedKmh that rejects the run */
  vehicleSpeedKmh: 25,
  maxVehicleShare: 0.15,
  /** Stretches above this speed and longer than cutSegmentMinM are cut out of the track */
  cutSpeedKmh: 30,
  cutSegmentMinM: 200,
  /** Jumps longer than this between consecutive points at an impossible speed are teleports */
  teleportMinM: 100,
  teleportSpeedKmh: 45,
  /** Without timestamps, a gap this long between two points is a teleport */
  untimedTeleportM: 2000,
  /** More teleports than this flag the run */
  maxTeleports: 3,
  /** Pace too steady for a human (car on cruise control): coefficient of variation of minute speeds */
  minSpeedVariation: 0.03,
  steadyCheckMinMinutes: 10,
  steadyCheckMinSpeedKmh: 15,
  /** Heart rate too low for the speed */
  suspiciousHrSpeedKmh: 15,
  suspiciousHrMax: 100,
  /** New global area that sends a run to review */
  reviewRunAreaM2: 10_000_000,
  reviewDayAreaM2: 20_000_000,
  /** Overlap in time with another run of the same user that makes it a duplicate */
  duplicateOverlap: 0.5,
  /** Moving time ignores stops: segments slower than this */
  stoppedSpeedKmh: 1.5,
};
