export class ShuffleNavigator {
  constructor(random = Math.random) {
    this.random = random;
    this.clear();
  }

  clear() {
    this.order = [];
    this.position = -1;
    this.size = 0;
    this.history = [];
  }

  reset(size, currentIndex) {
    this.size = Math.max(0, size);
    if (currentIndex < 0 || currentIndex >= this.size) return this.clear();
    const rest = Array.from({ length: this.size }, (_, index) => index).filter(index => index !== currentIndex);
    for (let index = rest.length - 1; index > 0; index--) {
      const swap = Math.floor(this.random() * (index + 1));
      [rest[index], rest[swap]] = [rest[swap], rest[index]];
    }
    this.order = [currentIndex, ...rest];
    this.position = 0;
    this.history = [];
  }

  ensure(size, currentIndex) {
    if (this.size !== size || this.order[this.position] !== currentIndex) this.reset(size, currentIndex);
  }

  snapshot(ids,currentIndex) {
    this.ensure(ids.length,currentIndex);
    return{shuffle_order:this.order.map(index=>ids[index]),playback_history:this.history.map(index=>ids[index])};
  }

  restore(ids,currentId,snapshot={}) {
    const positions=new Map(ids.map((id,index)=>[id,index]));
    const supplied=Array.isArray(snapshot.shuffle_order)?snapshot.shuffle_order:[];
    const indexes=[...new Set(supplied.filter(id=>positions.has(id)).map(id=>positions.get(id)))];
    const seen=new Set(indexes);
    for(let i=0;i<ids.length;i++)if(!seen.has(i)){seen.add(i);indexes.push(i);}
    this.order=indexes;this.size=ids.length;this.position=indexes.indexOf(positions.get(currentId));
    this.history=(Array.isArray(snapshot.playback_history)?snapshot.playback_history:[]).filter(id=>positions.has(id)).map(id=>positions.get(id));
  }

  next(size, currentIndex, playable = () => true, wrap = true) {
    this.ensure(size, currentIndex);
    for (let position = this.position + 1; position < this.order.length; position++) {
      const index = this.order[position];
      if (playable(index)) { this.history.push(currentIndex);if(this.history.length>10000)this.history.shift();this.position = position; return index; }
    }
    if (!wrap || size < 2) return -1;
    this.reset(size, currentIndex);
    return this.next(size, currentIndex, playable, false);
  }

  previous(size, currentIndex, playable = () => true) {
    this.ensure(size, currentIndex);
    while(this.history.length){const index=this.history.pop();if(playable(index)){this.position=this.order.indexOf(index);return index;}}
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

export function nextPlayableIndex(size, currentIndex, direction, playable, wrap = true) {
  if (size < 2 || currentIndex < 0 || currentIndex >= size || (direction !== 1 && direction !== -1)) return -1;
  for (let step = 1; step <= size; step++) {
    const candidate = currentIndex + direction * step;
    if (!wrap && (candidate < 0 || candidate >= size)) break;
    const index = (candidate % size + size) % size;
    if (index !== currentIndex && playable(index)) return index;
  }
  return -1;
}
