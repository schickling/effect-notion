/** Wrapper for a single item with map and filter operations */
export class SingleItem<T> {
  public item: T

  constructor(item: T) {
    this.item = item
  }

  map = <U>(fn: (item: T) => U): SingleItem<U> => new SingleItem(fn(this.item))

  filter = (fn: (item: T) => boolean): SingleItem<T | undefined> =>
    fn(this.item) === true ? this : new SingleItem(undefined)
}

/** Creates a SingleItem wrapper for pipeline-style transformations */
export const singleItem = <T>(item: T) => new SingleItem(item)
