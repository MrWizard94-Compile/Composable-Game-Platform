const I32_MAX = 2147483647;
const I32_MIN = -2147483648;

const meterState = {
  calls: 0,
  value: 0,
};

const passState = {
  next: 0,
  live: 0,
};

class Pass {
  #id;
  #module;
  #composition;
  #alive = true;

  constructor(id, module, composition) {
    this.#id = id;
    this.#module = module;
    this.#composition = composition;
    passState.live += 1;
  }

  id() {
    return this.#id;
  }

  module() {
    return this.#module;
  }

  composition() {
    return this.#composition;
  }

  [Symbol.dispose]() {
    if (!this.#alive) return;
    this.#alive = false;
    passState.live -= 1;
  }
}

function bump() {
  meterState.calls += 1;
}

export const meter = {
  calls() {
    return meterState.calls;
  },
  read() {
    bump();
    return { value: meterState.value, label: "js-meter" };
  },
  add(delta) {
    bump();
    if (!Number.isInteger(delta)) {
      throw "refused";
    }
    const next = meterState.value + delta;
    if (next > I32_MAX || next < I32_MIN) {
      throw "overflow";
    }
    meterState.value = next;
    return next;
  },
};

export const registry = {
  contributions() {
    return [
      { id: "js-early", order: 1, label: "js-meter" },
      { id: "shared", order: 1, label: "js-meter" },
      { id: "beta", order: 10, label: "js-meter" },
    ];
  },
};

export const passes = {
  Pass,
  live() {
    return passState.live;
  },
  issue(moduleId, composition) {
    const id = `js-${passState.next}`;
    passState.next += 1;
    return new Pass(id, moduleId, composition);
  },
  peek(ticket) {
    return `${ticket.id()}|${ticket.module()}|${ticket.composition()}`;
  },
  consume(ticket) {
    const text = `consumed:${ticket.id()}|${ticket.module()}|${ticket.composition()}`;
    if (typeof ticket[Symbol.dispose] === "function") ticket[Symbol.dispose]();
    return text;
  },
};
