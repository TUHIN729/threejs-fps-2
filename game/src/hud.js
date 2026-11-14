// The DOM HUD: health, armour, ammo, money, round timer, score, alive counts, bomb
// status, kill feed, crosshair, hit marker, damage vignette, buy menu and the overlays.
// It never touches the simulation; main.js and match.js push numbers in and read the
// play and buy callbacks out. Writes are cached so unchanged values never touch the DOM.
import { WEAPONS } from './weapons.js';

const ARMOR_PRICE = 650;
const GRENADE_PRICE = 300;

  const COPY = {
  start: {
    title: 'Emberline',
    copy: 'Cinder Yard. Your squad attacks; the Cinder crew holds the sites. Plant the charge at A or B, or clear them out. Click to play.',
    action: 'Click to play',
  },
  paused: {
    title: 'Emberline',
    copy: 'Paused. Click to resume.',
    action: 'Click to resume',
  },
  down: {
    title: 'You are down',
    copy: 'Your squad fights on without you.',
    action: 'Spectate',
  },
  matchWin: {
    title: 'Match won',
    copy: 'Vanguard takes Cinder Yard.',
    action: 'Play again',
  },
  matchLose: {
    title: 'Match lost',
    copy: 'The Cinder crew holds the yard.',
    action: 'Play again',
  },
};

function el(id) {
  return document.getElementById(id);
}

export function createHud() {
  const overlay = el('overlay');
  const title = el('overlay-title');
  const copy = el('overlay-copy');
  const play = el('play');
  const ammoMag = el('ammo-mag');
  const ammoReserve = el('ammo-reserve');
  const weaponName = el('weapon-name');
  const grenadeCount = el('grenade-count');
  const healthFill = el('health-fill');
  const healthNum = el('health-num');
  const armorNum = el('armor-num');
  const moneyValue = el('money-value');
  const timerValue = el('timer-value');
  const scoreV = el('score-vanguard');
  const scoreC = el('score-cinder');
  const roundLabel = el('round-label');
  const aliveV = el('alive-vanguard');
  const aliveC = el('alive-cinder');
  const bombStatus = el('bomb-status');
  const killfeed = el('killfeed');
  const banner = el('banner');
  const bannerTitle = el('banner-title');
  const bannerSub = el('banner-sub');
  const crosshair = el('crosshair');
  const hitmarker = el('hitmarker');
  const vignette = el('damage-vignette');
  const buyMenu = el('buy-menu');
  const buyList = el('buy-list');
  const buyMoney = el('buy-money');
  const plantBar = el('plant-progress');
  const plantFill = el('plant-fill');
  const plantLabel = el('plant-label');

  let lastMag = -1;
  let lastReserve = -1;
  let lastWeapon = '';
  let lastGrenades = -1;
  let lastHealth = -1;
  let lastArmor = -1;
  let lastMoney = -1;
  let lastTimer = '';
  let lastScore = '';
  let lastAlive = '';
  let lastBomb = '';
  let hitTimer = 0;
  let bannerTimer = 0;
  let buyHandler = null;

  // Build the buy menu once: four guns, armour, grenades.
  const items = [];
  for (const def of Object.values(WEAPONS)) {
    if (def.price > 0) items.push({ id: def.id, name: def.name, price: def.price, kind: 'weapon' });
  }
  items.push({ id: 'armor', name: 'Kevlar Vest', price: ARMOR_PRICE, kind: 'armor' });
  items.push({ id: 'grenade', name: 'Frag Grenade', price: GRENADE_PRICE, kind: 'grenade' });
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'buy-item';
    button.dataset.id = item.id;
    button.innerHTML = `<span class="buy-name"></span><span class="buy-price"></span>`;
    button.querySelector('.buy-name').textContent = item.name;
    button.querySelector('.buy-price').textContent = `$${item.price}`;
    button.addEventListener('click', () => {
      if (buyHandler) buyHandler(item.id);
    });
    buyList.appendChild(button);
  }

  return {
    setHealth(hp, armor) {
      if (hp === lastHealth && armor === lastArmor) return;
      lastHealth = hp;
      lastArmor = armor;
      healthFill.style.width = `${Math.max(0, hp)}%`;
      healthFill.classList.toggle('low', hp <= 30);
      healthNum.textContent = String(Math.max(0, Math.ceil(hp)));
      armorNum.textContent = armor > 0 ? `+${armor}` : '';
    },
    setAmmo(mag, reserve, weapon, grenades) {
      if (mag === lastMag && reserve === lastReserve && weapon === lastWeapon && grenades === lastGrenades) return;
      lastMag = mag;
      lastReserve = reserve;
      lastWeapon = weapon;
      lastGrenades = grenades;
      ammoMag.textContent = String(mag);
      ammoReserve.textContent = `/ ${reserve}`;
      weaponName.textContent = weapon;
      grenadeCount.textContent = grenades > 0 ? `◉ ${grenades}` : '';
      el('ammo').classList.toggle('empty', mag === 0);
    },
    setMoney(value) {
      if (value === lastMoney) return;
      lastMoney = value;
      moneyValue.textContent = `$${value}`;
      buyMoney.textContent = `$${value}`;
    },
    setTimer(text, urgent) {
      if (text === lastTimer) return;
      lastTimer = text;
      timerValue.textContent = text;
      timerValue.classList.toggle('urgent', urgent);
    },
    setScore(vanguard, cinder, round) {
      const text = `${vanguard}-${cinder}-${round}`;
      if (text === lastScore) return;
      lastScore = text;
      scoreV.textContent = String(vanguard);
      scoreC.textContent = String(cinder);
      roundLabel.textContent = `ROUND ${round}`;
    },
    setAlive(vanguard, cinder) {
      const text = `${vanguard}|${cinder}`;
      if (text === lastAlive) return;
      lastAlive = text;
      aliveV.textContent = '●'.repeat(Math.max(0, vanguard));
      aliveC.textContent = '●'.repeat(Math.max(0, cinder));
    },
    setBomb(text) {
      if (text === lastBomb) return;
      lastBomb = text;
      bombStatus.textContent = text;
      bombStatus.hidden = text === '';
    },
    setPlant(progress, label) {
      if (progress <= 0) {
        plantBar.hidden = true;
        return;
      }
      plantBar.hidden = false;
      plantFill.style.width = `${Math.round(progress * 100)}%`;
      plantLabel.textContent = label;
    },
    setCrosshairGap(px) {
      crosshair.style.setProperty('--gap', `${px.toFixed(1)}px`);
    },
    killfeed(text) {
      const line = document.createElement('div');
      line.className = 'feed-line';
      line.textContent = text;
      killfeed.prepend(line);
      while (killfeed.children.length > 5) killfeed.removeChild(killfeed.lastChild);
      setTimeout(() => line.remove(), 6000);
    },
    hitMarker(killed, holdMs = 90) {
      hitmarker.classList.add('on');
      hitmarker.classList.toggle('kill', killed);
      clearTimeout(hitTimer);
      hitTimer = setTimeout(() => hitmarker.classList.remove('on', 'kill'), holdMs);
    },
    damageFlash() {
      vignette.classList.add('on');
      setTimeout(() => vignette.classList.remove('on'), 180);
    },
    showBanner(titleText, subText, holdMs = 2600) {
      bannerTitle.textContent = titleText;
      bannerSub.textContent = subText;
      banner.hidden = false;
      clearTimeout(bannerTimer);
      bannerTimer = setTimeout(() => {
        banner.hidden = true;
      }, holdMs);
    },
    hideBanner() {
      banner.hidden = true;
      clearTimeout(bannerTimer);
    },
    showOverlay(mode, detail = '') {
      const text = COPY[mode];
      title.textContent = text.title;
      copy.textContent = detail ? `${text.copy} ${detail}` : text.copy;
      play.textContent = text.action;
      overlay.hidden = false;
      play.focus();
    },
    hideOverlay() {
      overlay.hidden = true;
    },
    onPlay(handler) {
      play.addEventListener('click', handler);
    },
    showBuy(open) {
      buyMenu.hidden = !open;
    },
    buyOpen() {
      return !buyMenu.hidden;
    },
    onBuy(handler) {
      buyHandler = handler;
    },
    refreshBuy(money, ownedWeapon, hasArmor, grenades) {
      for (const button of buyList.children) {
        const id = button.dataset.id;
        const item = items.find((i) => i.id === id);
        const owned = id === ownedWeapon || (id === 'armor' && hasArmor) || (id === 'grenade' && grenades >= 2);
        button.classList.toggle('owned', owned);
        button.classList.toggle('poor', !owned && money < item.price);
      }
    },
  };
}
