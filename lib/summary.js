// Pure functions that turn raw rows into the totals shown on "Lock & total"
// and in Reports. Kept separate from server.js so the rules are easy to find
// and test on their own.

function computeScheduleSummary(rows) {
  let trip = 0, noTrip = 0, taxi = 0;
  const people = {};
  rows.forEach((r) => {
    const name = (r.traveller || "").trim();
    const isTaxi = /^no ?driver$/i.test(name) || /^taxi$/i.test(r.tripType || "");
    if (isTaxi) {
      taxi++;
      people["No Driver"] = people["No Driver"] || { trip: 0, noTrip: 0 };
      people["No Driver"].trip++;
    } else if (/^no trip$/i.test(r.tripType || "")) {
      noTrip++;
      if (name) {
        people[name] = people[name] || { trip: 0, noTrip: 0 };
        people[name].noTrip++;
      }
    } else if (/^trip$/i.test(r.tripType || "")) {
      trip++;
      if (name) {
        people[name] = people[name] || { trip: 0, noTrip: 0 };
        people[name].trip++;
      }
    }
  });
  return { trip, noTrip, taxi, people };
}

function computeFuelSummary(rows) {
  const totals = {};
  let grand = 0;
  rows.forEach((r) => {
    const key = (r.fuel || "").trim().toLowerCase();
    const amt = (parseFloat(r.qty) || 0) * (parseFloat(r.price) || 0);
    if (key) {
      totals[key] = (totals[key] || 0) + amt;
      grand += amt;
    }
  });
  return { totals, grand };
}

function computeServiceSummary(rows) {
  const totals = {};
  let grand = 0;
  rows.forEach((r) => {
    const key = (r.vehicle || "").trim();
    const cost = parseFloat(r.cost) || 0;
    if (key) {
      totals[key] = (totals[key] || 0) + cost;
      grand += cost;
    }
  });
  return { totals, grand };
}

module.exports = { computeScheduleSummary, computeFuelSummary, computeServiceSummary };
