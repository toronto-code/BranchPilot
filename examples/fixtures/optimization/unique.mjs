export function unique(values) {
  return values.filter((value, index) => values.indexOf(value) === index);
}
