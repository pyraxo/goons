export function createGoldReservationStore({ game, onChanged }) {
  const reservations = new Map();

  function notify() {
    onChanged?.();
  }

  function canSpendGold(amount) {
    return game.gold >= amount;
  }

  function reserveGold(amount) {
    if (!canSpendGold(amount)) {
      return null;
    }

    game.gold -= amount;
    const reservationId = `res_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    reservations.set(reservationId, amount);
    notify();
    return reservationId;
  }

  function commitReservedGold(reservationId) {
    if (!reservations.has(reservationId)) {
      return false;
    }

    reservations.delete(reservationId);
    notify();
    return true;
  }

  function refundReservedGold(reservationId) {
    const amount = reservations.get(reservationId);
    if (amount === undefined) {
      return false;
    }

    reservations.delete(reservationId);
    game.gold += amount;
    notify();
    return true;
  }

  function getReservedGold() {
    let total = 0;
    for (const amount of reservations.values()) {
      total += amount;
    }
    return total;
  }

  function clearReservations() {
    reservations.clear();
    notify();
  }

  return {
    canSpendGold,
    reserveGold,
    commitReservedGold,
    refundReservedGold,
    getReservedGold,
    clearReservations,
  };
}
