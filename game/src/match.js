// The match: rounds, economy, the charge, and the score. Vanguard attacks, Cinder
// defends. A round is 12 s of buy time, then 100 s live. It ends when one side is wiped,
// when the planted charge detonates, when Cinder defuses it, or when time runs out with
// the charge unplanted. First to 5 rounds takes the match. Money is earned for kills,
// plants and round wins, and spent in the buy menu between rounds.
import { MAP } from './map.js';
import { WEAPONS } from './weapons.js';

export const BUY_SECONDS = 12;
export const ROUND_SECONDS = 100;
export const PLANT_SECONDS = 3;
export const DEFUSE_SECONDS = 5;
export const FUSE_SECONDS = 35;
export const WIN_ROUNDS = 5;
export const MAX_ROUNDS = 9;
export const KILL_REWARD = 300;
export const PLANT_REWARD = 300;
export const WIN_REWARD = 325;
export const LOSS_REWARD = 150;
export const ARMOR_PRICE = 650;
export const GRENADE_PRICE = 300;
export const START_MONEY = 800;

export function createMatch(hud, events) {
  const state = {
    phase: 'buy',
    round: 1,
    scoreVanguard: 0,
    scoreCinder: 0,
    money: START_MONEY,
    weapon: 'pistol',
    armor: 0,
    grenades: 0,
    planSite: 'A',
    buyTime: BUY_SECONDS,
    roundTime: ROUND_SECONDS,
    roundOverTime: 0,
    bomb: {
      carried: true,
      planted: false,
      site: null,
      pos: null,
      plantProgress: 0,
      defuseProgress: 0,
      fuseLeft: FUSE_SECONDS,
    },
  };

  function syncHud() {
    hud.setScore(state.scoreVanguard, state.scoreCinder, state.round);
    hud.setMoney(state.money);
  }

  function startRound() {
    state.planSite = Math.random() < 0.5 ? 'A' : 'B';
    state.phase = 'buy';
    state.buyTime = BUY_SECONDS;
    state.roundTime = ROUND_SECONDS;
    state.bomb.carried = true;
    state.bomb.planted = false;
    state.bomb.site = null;
    state.bomb.pos = null;
    state.bomb.plantProgress = 0;
    state.bomb.defuseProgress = 0;
    state.bomb.fuseLeft = FUSE_SECONDS;
    hud.setBomb('');
    hud.setPlant(0, '');
    syncHud();
    events.roundStarted(state.round, state.planSite);
  }

  function endRound(winner, reason) {
    if (state.phase === 'roundOver' || state.phase === 'matchOver') return;
    if (winner === 'vanguard') {
      state.scoreVanguard += 1;
      state.money += WIN_REWARD;
    } else {
      state.scoreCinder += 1;
      state.money += LOSS_REWARD;
    }
    state.phase = 'roundOver';
    state.roundOverTime = 4.5;
    syncHud();
    events.roundEnded(winner, reason, state.round);
  }

  function endMatch() {
    state.phase = 'matchOver';
    events.matchEnded(state.scoreVanguard > state.scoreCinder ? 'vanguard' : 'cinder');
  }

  return {
    state,
    startMatch() {
      state.round = 1;
      state.scoreVanguard = 0;
      state.scoreCinder = 0;
      state.money = START_MONEY;
      state.weapon = 'pistol';
      state.armor = 0;
      state.grenades = 0;
      startRound();
    },
    nextRound() {
      if (state.scoreVanguard >= WIN_ROUNDS || state.scoreCinder >= WIN_ROUNDS || state.round >= MAX_ROUNDS) {
        endMatch();
        return;
      }
      state.round += 1;
      startRound();
    },
    awardKill() {
      state.money += KILL_REWARD;
      hud.setMoney(state.money);
    },
    buy(id) {
      if (state.phase !== 'buy') return { ok: false, reason: 'Buy time is over' };
      if (id === 'armor') {
        if (state.armor > 0) return { ok: false, reason: 'Already armoured' };
        if (state.money < ARMOR_PRICE) return { ok: false, reason: 'Not enough money' };
        state.money -= ARMOR_PRICE;
        state.armor = 100;
      } else if (id === 'grenade') {
        if (state.grenades >= 2) return { ok: false, reason: 'Carrying two already' };
        if (state.money < GRENADE_PRICE) return { ok: false, reason: 'Not enough money' };
        state.money -= GRENADE_PRICE;
        state.grenades += 1;
      } else {
        const def = WEAPONS[id];
        if (!def) return { ok: false, reason: 'No such weapon' };
        if (state.weapon === id) return { ok: false, reason: 'Already owned' };
        if (state.money < def.price) return { ok: false, reason: 'Not enough money' };
        state.money -= def.price;
        state.weapon = id;
      }
      hud.setMoney(state.money);
      events.bought(id);
      return { ok: true };
    },
    step(dt, ctx) {
      if (state.phase === 'buy') {
        state.buyTime -= dt;
        hud.setTimer(`BUY ${Math.ceil(Math.max(0, state.buyTime))}`, false);
        if (state.buyTime <= 0) {
          state.phase = 'live';
          hud.showBuy(false);
          events.liveStarted();
        }
        return;
      }
      if (state.phase === 'live') {
        const bomb = state.bomb;
        if (bomb.planted) {
          bomb.fuseLeft -= dt;
          hud.setTimer(`0:${String(Math.max(0, Math.ceil(bomb.fuseLeft))).padStart(2, '0')}`, true);
          hud.setBomb(`CHARGE AT ${bomb.site} — ${Math.ceil(Math.max(0, bomb.fuseLeft))}s`);
          events.bombTick(bomb.fuseLeft);
          if (ctx.defuser) {
            bomb.defuseProgress += dt / DEFUSE_SECONDS;
            hud.setPlant(bomb.defuseProgress, 'DEFUSING…');
            if (bomb.defuseProgress >= 1) {
              bomb.planted = false;
              hud.setPlant(0, '');
              events.bombDefused();
              endRound('cinder', 'Charge defused');
              return;
            }
          } else {
            bomb.defuseProgress = Math.max(0, bomb.defuseProgress - dt / DEFUSE_SECONDS);
            hud.setPlant(0, '');
          }
          if (bomb.fuseLeft <= 0) {
            events.bombExploded(bomb.pos.clone());
            endRound('vanguard', 'Charge detonated');
            return;
          }
        } else {
          state.roundTime -= dt;
          const seconds = Math.max(0, Math.ceil(state.roundTime));
          hud.setTimer(`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`, seconds <= 15);
          hud.setBomb(ctx.carrying ? `CHARGE — plant at ${state.planSite}` : '');
          if (ctx.planting && ctx.site && ctx.playerAlive) {
            bomb.plantProgress += dt / PLANT_SECONDS;
            hud.setPlant(bomb.plantProgress, `PLANTING AT ${ctx.site}…`);
            if (bomb.plantProgress >= 1) {
              bomb.carried = false;
              bomb.planted = true;
              bomb.site = ctx.site;
              bomb.pos = ctx.sitePos.clone();
              bomb.fuseLeft = FUSE_SECONDS;
              state.money += PLANT_REWARD;
              hud.setMoney(state.money);
              hud.setPlant(0, '');
              events.bombPlanted(ctx.site);
            }
          } else {
            bomb.plantProgress = Math.max(0, bomb.plantProgress - dt / PLANT_SECONDS);
            if (bomb.plantProgress <= 0) hud.setPlant(0, '');
          }
          if (state.roundTime <= 0) {
            endRound('cinder', 'Time expired — charge never planted');
            return;
          }
        }
        // Elimination ends the round, unless the charge is ticking.
        if (ctx.cinderAlive === 0) {
          endRound('vanguard', 'Cinder squad wiped');
          return;
        }
        if (ctx.vanguardAlive === 0 && !bomb.planted) {
          endRound('cinder', 'Vanguard squad wiped');
        }
        return;
      }
      if (state.phase === 'roundOver') {
        state.roundOverTime -= dt;
        if (state.roundOverTime <= 0) this.nextRound();
      }
    },
    siteAt(position) {
      for (const [key, site] of Object.entries(MAP.sites)) {
        if (
          Math.abs(position.x - site.center.x) <= site.half
          && Math.abs(position.z - site.center.z) <= site.half
        ) return key;
      }
      return null;
    },
  };
}
