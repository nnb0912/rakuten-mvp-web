export type RppDeliveryWarningAction = "ON" | "OFF";

export type RppDeliveryWarningRecurring = {
  enabled: boolean;
  startTime: string;
  endTime: string;
};

export type RppDeliveryWarningReservation = {
  action: RppDeliveryWarningAction;
  executeAt: string;
  status?: string;
};

export type RppDeliveryWarning = {
  key: string;
  message: string;
};

export type RppDeliveryAssessment = {
  blocked: { key: string; message: string } | null;
  warnings: RppDeliveryWarning[];
};

export function rppDeliveryWarningKeysMatch(requiredWarnings: RppDeliveryWarning[], acknowledgedInput: unknown) {
  const required = [...new Set(requiredWarnings.map((warning) => warning.key))].sort();
  const acknowledged = [...new Set(Array.isArray(acknowledgedInput) ? acknowledgedInput.map(String) : [])].sort();
  return required.length === acknowledged.length && required.every((key, index) => key === acknowledged[index]);
}

const HH_MM = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

function jstTime(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.hour}:${values.minute}`;
}

export function isInsideRppRecurringWindow(recurring: RppDeliveryWarningRecurring, executeAt: string) {
  if (!recurring.enabled || !HH_MM.test(recurring.startTime) || !HH_MM.test(recurring.endTime) || recurring.startTime === recurring.endTime) return false;
  const time = jstTime(executeAt);
  if (!time) return false;
  return recurring.startTime < recurring.endTime
    ? time >= recurring.startTime && time < recurring.endTime
    : time >= recurring.startTime || time < recurring.endTime;
}

export function assessRppDeliveryReservation(
  recurring: RppDeliveryWarningRecurring | undefined,
  reservation: RppDeliveryWarningReservation,
  sourceKey = "DAILY",
  sourceLabel = "毎日停止",
): RppDeliveryAssessment {
  if (!recurring?.enabled) return { blocked: null, warnings: [] };
  const time = jstTime(reservation.executeAt);
  if (!time) return { blocked: null, warnings: [] };
  if (time === recurring.startTime && reservation.action === "ON") {
    return { blocked: { key: `${sourceKey}:START:ON`, message: `${sourceLabel}の開始時刻と正反対になるON予約は登録できません。` }, warnings: [] };
  }
  if (time === recurring.endTime && reservation.action === "OFF") {
    return { blocked: { key: `${sourceKey}:END:OFF`, message: `${sourceLabel}の終了時刻と正反対になるOFF予約は登録できません。` }, warnings: [] };
  }
  const inside = isInsideRppRecurringWindow(recurring, reservation.executeAt);
  if (inside && reservation.action === "ON") {
    return { blocked: null, warnings: [{ key: `${sourceKey}:INSIDE:ON`, message: `${sourceLabel}時間内のON予約です。この回の停止を上書きして広告ONに戻します。` }] };
  }
  if (inside && reservation.action === "OFF") {
    return { blocked: null, warnings: [{ key: `${sourceKey}:INSIDE:OFF`, message: `${sourceLabel}時間内のOFF予約で、毎日停止と動作が重複します。停止終了後もOFFを維持するため、戻すにはON予約が必要です。` }] };
  }
  if (reservation.action === "OFF") {
    return { blocked: null, warnings: [{ key: `${sourceKey}:OUTSIDE:OFF`, message: `${sourceLabel}時間外のOFF予約は、終了時刻を過ぎてもOFFを維持します。戻すにはON予約が必要です。` }] };
  }
  return { blocked: null, warnings: [{ key: `${sourceKey}:OUTSIDE:ON`, message: `このON予約後も、次の${sourceLabel}開始時刻には自動でOFFになります。` }] };
}

export function rppDeliveryReservationWarnings(
  recurring: RppDeliveryWarningRecurring | undefined,
  reservation: RppDeliveryWarningReservation,
) {
  return assessRppDeliveryReservation(recurring, reservation).warnings.map((row) => row.message);
}

export function rppDeliveryScheduleWarningRecords(
  recurring: RppDeliveryWarningRecurring | undefined,
  reservations: RppDeliveryWarningReservation[],
  sourceKey = "DAILY",
  sourceLabel = "毎日停止",
) {
  const records = reservations
    .filter((row) => !row.status || row.status === "PENDING" || row.status === "RUNNING")
    .flatMap((row) => assessRppDeliveryReservation(recurring, row, sourceKey, sourceLabel).warnings);
  return [...new Map(records.map((row) => [row.key, row])).values()];
}

export function rppDeliveryScheduleWarnings(
  recurring: RppDeliveryWarningRecurring | undefined,
  reservations: RppDeliveryWarningReservation[],
) {
  return rppDeliveryScheduleWarningRecords(recurring, reservations).map((row) => row.message);
}
