'use strict';

const { listWallboxes } = require('../wallbox/boxes');
const { readWallboxValues } = require('../wallbox/aggregation');
const { priorityForMode, FULL_SOC, BUSINESS_FORCE_HOUR } = require('../wallbox/planner');

const DEFAULT_PROFILE = Array(24).fill(1 / 24);

function dbAll(db, sql, params = []) {
  return new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || [])));
}

function weekday(key) {
  const [year, month, day] = String(key).split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

function normalized(values, fallback = DEFAULT_PROFILE) {
  const safe = values.map((value) => Math.max(0, Number(value) || 0));
  const sum = safe.reduce((total, value) => total + value, 0);
  return sum > 0 ? safe.map((value) => value / sum) : [...fallback];
}

function weightedAverage(rows) {
  let total = 0;
  let weight = 0;
  rows.forEach((row, index) => {
    const w = Math.exp(-index / 8);
    total += Math.max(0, Number(row.consumption_kwh) || 0) * w;
    weight += w;
  });
  return weight > 0 ? total / weight : 0;
}

async function buildWallboxModel(db, currentDayKey, historyDays = 28, currentHour = 0, currentMinute = 0, cache = null) {
  const boxes = await listWallboxes(db);
  if (!boxes.length) return { boxes: [], todayRemainingByHour: Array(24).fill(0), yearKwh: 0, previousYearKwh: 0 };
  const dailyRows = await dbAll(db,
    `SELECT wallbox_id, day_key, consumption_kwh
       FROM wallbox_daily_consumption
      WHERE completed = 1 AND day_key < ? AND day_key >= date(?, '-' || ? || ' days')
      ORDER BY day_key DESC`,
    [currentDayKey, currentDayKey, Math.max(28, historyDays * 2)]
  );
  const hourlyRows = await dbAll(db,
    `SELECT wallbox_id, day_key, hour, consumption_kwh
       FROM wallbox_hourly_consumption
      WHERE day_key < ? AND day_key >= date(?, '-90 days')`,
    [currentDayKey, currentDayKey]
  );
  const todayRows = await dbAll(db,
    'SELECT wallbox_id, consumption_kwh FROM wallbox_daily_consumption WHERE day_key = ?',
    [currentDayKey]
  );
  const summaryRows = await dbAll(db,
    `SELECT s.wallbox_id, s.year_offset, s.previous_year_total, COALESCE(c.day_total, 0) AS today
       FROM wallbox_summary_state s
       LEFT JOIN wallbox_counter_state c ON c.wallbox_id = s.wallbox_id`
  );
  const todayById = new Map(todayRows.map((row) => [Number(row.wallbox_id), Number(row.consumption_kwh) || 0]));
  const liveValues = cache
    ? await readWallboxValues(db, cache, boxes).catch(() => [])
    : [];
  const liveById = new Map(liveValues.map((value) => [Number(value.id), value]));
  const models = [];

  for (const box of boxes) {
    const ownDays = dailyRows.filter((row) => Number(row.wallbox_id) === box.id);
    const globalDaily = weightedAverage(ownDays);
    const ownHours = hourlyRows.filter((row) => Number(row.wallbox_id) === box.id);
    const globalHourly = Array(24).fill(0);
    ownHours.forEach((row) => { globalHourly[Number(row.hour)] += Number(row.consumption_kwh) || 0; });
    const globalProfile = normalized(globalHourly);
    const dailyByWeekday = [];
    const profilesByWeekday = [];
    const samplesByWeekday = [];

    for (let day = 0; day < 7; day += 1) {
      const matchingDays = ownDays.filter((row) => weekday(row.day_key) === day);
      const count = matchingDays.length;
      const specific = weightedAverage(matchingDays);
      const confidence = Math.min(1, count / 3);
      dailyByWeekday[day] = specific * confidence + globalDaily * (1 - confidence);
      samplesByWeekday[day] = count;
      const hourly = Array(24).fill(0);
      ownHours.filter((row) => weekday(row.day_key) === day)
        .forEach((row) => { hourly[Number(row.hour)] += Number(row.consumption_kwh) || 0; });
      const specificProfile = normalized(hourly, globalProfile);
      profilesByWeekday[day] = specificProfile.map(
        (value, hour) => value * confidence + globalProfile[hour] * (1 - confidence)
      );
    }
    const live = liveById.get(box.id) || {};
    models.push({
      id: box.id, name: box.name, todayKwh: todayById.get(box.id) || 0,
      dailyByWeekday, profilesByWeekday, samplesByWeekday,
      mode: box.mode,
      priority: priorityForMode(box),
      maxPowerW: box.maxPowerW,
      batteryCapacityKwh: box.batteryCapacityKwh,
      minChargePercent: box.minChargePercent,
      businessDays: box.businessDays,
      hasSetpoint: !!box.setpointTopic,
      soc: live.soc == null ? null : Number(live.soc),
      plugged: live.plugged == null ? null : !!live.plugged,
      powerW: live.powerW == null ? null : Number(live.powerW),
    });
  }

  const todayWeekday = weekday(currentDayKey);
  const todayRemainingByHour = Array(24).fill(0);
  for (const box of models) {
    const target = box.dailyByWeekday[todayWeekday] || 0;
    const remaining = Math.max(0, target - box.todayKwh);
    box.todayRemainingKwh = remaining;
    const profile = box.profilesByWeekday[todayWeekday] || DEFAULT_PROFILE;
    const weights = profile.map((value, hour) => {
      if (hour < currentHour) return 0;
      if (hour === currentHour) return value * (1 - currentMinute / 60);
      return value;
    });
    const weightTotal = weights.reduce((sum, value) => sum + value, 0);
    weights.forEach((value, hour) => {
      if (weightTotal > 0) todayRemainingByHour[hour] += remaining * value / weightTotal;
    });
  }
  return {
    boxes: models,
    todayRemainingByHour,
    yearKwh: summaryRows.reduce((sum, row) => sum + Number(row.year_offset || 0) + Number(row.today || 0), 0),
    previousYearKwh: summaryRows.reduce((sum, row) => sum + Number(row.previous_year_total || 0), 0),
  };
}

function weekdayMonZero(key) {
  return (weekday(key) + 6) % 7;
}

function isBusinessDay(box, key) {
  return Array.isArray(box.businessDays) && box.businessDays.includes(weekdayMonZero(key));
}

function addPlannedEnergy(box, slots, amountKwh, surplusOnly) {
  let remaining = Math.max(0, Number(amountKwh) || 0);
  const maxPowerKwh = Math.max(0, Number(box.maxPowerW) || 0) / 1000;
  if (!(remaining > 0) || !(maxPowerKwh > 0)) return remaining;
  for (const slot of slots) {
    if (!(remaining > 0.000001)) break;
    const capacity = maxPowerKwh * slot.durationHours;
    const available = surplusOnly ? Math.max(0, slot.surplusRemainingKwh) : capacity;
    const take = Math.min(remaining, capacity, available);
    if (!(take > 0)) continue;
    box.plannedHourlyByDate[slot.dateKey][slot.hour] += take;
    box.plannedEnergyByDate[slot.dateKey] += take;
    if (surplusOnly) box.plannedFlexibleEnergyByDate[slot.dateKey] += take;
    slot.surplusRemainingKwh = Math.max(0, slot.surplusRemainingKwh - take);
    remaining -= take;
  }
  return remaining;
}

// Gemeinsamer Vorausplan für Prognose und Wallbox-Automatik. Pflichtladungen
// werden fest eingeplant; reine Überschussladungen teilen sich den freien
// PV-Überschuss nach Verbraucherpriorität, sodass er nicht mehrfach vergeben wird.
function initializeOverflow(slots, storage = null) {
  if (!storage || !Number.isFinite(Number(storage.capacityKwh))) {
    for (const slot of slots) {
      slot.surplusRemainingKwh = Math.max(0, Number(slot.pvKwh) - Number(slot.houseKwh));
    }
    return;
  }
  const capacity = Math.max(0, Number(storage.capacityKwh));
  const minSoc = Math.max(0, Math.min(100, Number(storage.minSoc) || 0));
  const soc = Math.max(minSoc, Math.min(100, Number(storage.soc) || minSoc));
  const usable = capacity * (1 - minSoc / 100);
  let stored = Math.max(0, Math.min(usable, capacity * (soc - minSoc) / 100));
  const chargeEfficiency = Math.max(0.01, Math.min(1, Number(storage.chargeEfficiency) || 0.9));
  const dischargeEfficiency = Math.max(0.01, Math.min(1, Number(storage.dischargeEfficiency) || 0.9));
  for (const slot of slots) {
    const balance = Number(slot.pvKwh) - Number(slot.houseKwh);
    slot.surplusRemainingKwh = 0;
    if (balance >= 0) {
      const chargeInput = Math.min(balance, Math.max(0, (usable - stored) / chargeEfficiency));
      stored += chargeInput * chargeEfficiency;
      slot.surplusRemainingKwh = Math.max(0, balance - chargeInput);
    } else {
      const shortfall = -balance;
      const supplied = Math.min(shortfall, stored * dischargeEfficiency);
      stored -= supplied / dischargeEfficiency;
    }
  }
}

function planWallboxSchedule(model, slots = [], storage = null) {
  if (!model || !Array.isArray(model.boxes) || !slots.length) return model;
  const dateKeys = [...new Set(slots.map((slot) => slot.dateKey))];
  const slotsByDate = new Map(dateKeys.map((key) => [key, slots.filter((slot) => slot.dateKey === key)]));
  initializeOverflow(slots, storage);

  const ordered = [...model.boxes].sort((a, b) => a.priority - b.priority || a.id - b.id);
  for (const box of ordered) {
    box.plannedHourlyByDate = Object.fromEntries(dateKeys.map((key) => [key, Array(24).fill(0)]));
    box.plannedEnergyByDate = Object.fromEntries(dateKeys.map((key) => [key, 0]));
    box.plannedFlexibleEnergyByDate = Object.fromEntries(dateKeys.map((key) => [key, 0]));
    const capacity = Math.max(0, Number(box.batteryCapacityKwh) || 0);
    const soc = Number.isFinite(box.soc) ? Math.max(0, Math.min(FULL_SOC, box.soc)) : null;
    const energyToFull = soc == null ? null : capacity * Math.max(0, FULL_SOC - soc) / 100;
    const energyToMinimum = soc == null ? 0
      : capacity * Math.max(0, (Number(box.minChargePercent) || 0) - soc) / 100;

    const currentPrivateVehicle = box.mode === 1 && energyToFull != null && box.plugged !== false;
    if (currentPrivateVehicle) {
      // Der aktuelle Fahrzeugbedarf endet nicht am Tageswechsel. Mindestladung
      // ist verbindlich; der restliche Bedarf darf über den gesamten sichtbaren
      // Horizont ausschließlich echten Überschuss nach Hausakku nutzen.
      const mandatoryTarget = Math.min(energyToFull, energyToMinimum);
      const mandatoryLeft = mandatoryTarget > 0
        ? addPlannedEnergy(box, slots, mandatoryTarget, false)
        : 0;
      const mandatoryDelivered = mandatoryTarget - mandatoryLeft;
      addPlannedEnergy(box, slots, Math.max(0, energyToFull - mandatoryDelivered), true);
    } else dateKeys.forEach((key, dayIndex) => {
      const daySlots = slotsByDate.get(key) || [];
      const learned = dayIndex === 0
        ? Math.max(0, Number(box.todayRemainingKwh) || 0)
        : Math.max(0, Number(box.dailyByWeekday[weekday(key)]) || 0);
      let desired = learned;
      let mandatory = 0;

      // Der Live-SoC gehört zum aktuell angeschlossenen Fahrzeug und ersetzt
      // daher nur den heutigen statistischen Bedarf.
      if (dayIndex === 0 && energyToFull != null) {
        desired = box.mode === 1 ? energyToFull : Math.min(energyToFull, Math.max(learned, energyToMinimum));
        if (box.mode === 3) {
          desired = energyToFull;
          mandatory = desired;
        } else if (box.mode === 1 && energyToMinimum > 0) {
          mandatory = energyToMinimum;
        } else if (box.mode === 2) {
          const tomorrowKey = dateKeys[1];
          const beforeBusiness = isBusinessDay(box, key) || (tomorrowKey && isBusinessDay(box, tomorrowKey));
          if (beforeBusiness) desired = energyToFull;
        }
      }

      if (box.mode === 2) {
        const nextKey = dateKeys[dayIndex + 1];
        const beforeBusiness = isBusinessDay(box, key) || (nextKey && isBusinessDay(box, nextKey));
        if (beforeBusiness) {
          let remaining = addPlannedEnergy(box, daySlots, desired, true);
          if (remaining > 0) {
            remaining = addPlannedEnergy(
              box,
              daySlots.filter((slot) => slot.hour >= BUSINESS_FORCE_HOUR),
              remaining,
              false
            );
          }
          if (remaining > 0 && dayIndex === 0) {
            addPlannedEnergy(box, slots.filter((slot) => slot.dayIndex > 0), remaining, false);
          }
          return;
        }
      }

      let remaining = desired;
      if (mandatory > 0) {
        const mandatoryLeft = addPlannedEnergy(box, daySlots, mandatory, false);
        remaining = mandatoryLeft + Math.max(0, desired - mandatory);
      }
      addPlannedEnergy(box, daySlots, remaining, true);
    });

    const first = slots.find((slot) => box.plannedHourlyByDate[slot.dateKey][slot.hour] > 0.000001);
    box.nextCharge = first ? { at: first.startMs, hour: first.hour, dateKey: first.dateKey } : null;
  }

  model.planned = true;
  model.todayRemainingByHour = Array(24).fill(0);
  for (const box of model.boxes) {
    const today = dateKeys[0];
    (box.plannedHourlyByDate[today] || []).forEach((value, hour) => {
      model.todayRemainingByHour[hour] += value;
    });
  }
  return model;
}

function wallboxForecastForDay(model, dayKey, dayIndex = 0) {
  const day = weekday(dayKey);
  const perBox = [];
  const hourly = Array(24).fill(0);
  for (const box of (model && model.boxes) || []) {
    const plannedHourly = box.plannedHourlyByDate && box.plannedHourlyByDate[dayKey];
    const energyKwh = plannedHourly
      ? plannedHourly.reduce((sum, value) => sum + value, 0)
      : (dayIndex === 0 ? box.todayRemainingKwh || 0 : box.dailyByWeekday[day] || 0);
    const profile = box.profilesByWeekday[day] || DEFAULT_PROFILE;
    perBox.push({ id: box.id, name: box.name, energyKwh, samples: box.samplesByWeekday[day] || 0 });
    if (plannedHourly) plannedHourly.forEach((value, hour) => { hourly[hour] += value; });
    else if (dayIndex > 0) profile.forEach((share, hour) => { hourly[hour] += energyKwh * share; });
  }
  if (dayIndex === 0 && model && !model.planned && Array.isArray(model.todayRemainingByHour)) {
    model.todayRemainingByHour.forEach((value, hour) => { hourly[hour] = value; });
  }
  return { hourly, totalKwh: hourly.reduce((sum, value) => sum + value, 0), perBox };
}

module.exports = {
  buildWallboxModel, planWallboxSchedule, wallboxForecastForDay,
  normalized, weightedAverage,
};
