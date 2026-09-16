export class ShuffleNavigator {
  constructor(random = Math.random) {
    this.random = random;
    this.clear();
  }

  clear() { this.order = []; this.position = -1; this.size = 0; }

  reset(size, currentIndex) {
    this.size = Math.max(0, size);
    if (currentIndex < 0 || currentIndex >= this.size) return this.clear();
    const rest = Array.from({ length: this.size }, (_, index) => index).filter(index => index !== currentIndex);
    for (let index = rest.length - 1; index > 0; index--) {
      const swap = Math.floor(this.random() * (index + 1));
      [rest[index], rest[swap]] = [rest[swap], rest[index]];
    }
    this.order = [currentIndex, ...rest]; this.position = 0;
  }

  ensure(size, currentIndex) { if (this.size !== size || this.order[this.position] !== currentIndex) this.reset(size, currentIndex); }

  next(size, currentIndex, playable = () => true, wrap = true) {
    this.ensure(size, currentIndex);
    for (let position = this.position + 1; position < this.order.length; position++) { const index = this.order[position]; if (playable(index)) { this.position = position; return index; } }
    if (!wrap || size < 2) return -1;
    this.reset(size, currentIndex); return this.next(size, currentIndex, playable, false);
  }

  previous(size, currentIndex, playable = () => true) {
    this.ensure(size, currentIndex);
    for (let position = this.position - 1; position >= 0; position--) { const index = this.order[position]; if (playable(index)) { this.position = position; return index; } }
    return -1;
  }

  peekNext(size, currentIndex, playable = () => true, wrap = true) {
    return this.peekUpcoming(size, currentIndex, playable, 1, wrap)[0] ?? -1;
  }

  peekUpcoming(size, currentIndex, playable = () => true, count = 2, wrap = true) {
    this.ensure(size, currentIndex);
    const result = [];
    for (let position = this.position + 1; position < this.order.length; position++) {
      const index = this.order[position];
      if (playable(index)) result.push(index);
      if (result.length >= count) return result;
    }
    if (wrap && size > 1) {
      for (let position = 0; position < this.position; position++) {
        const index = this.order[position];
        if (playable(index) && !result.includes(index)) result.push(index);
        if (result.length >= count) break;
      }
    }
    return result;
  }
}
