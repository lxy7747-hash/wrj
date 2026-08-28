<template>
  <svg
    class="brand-icon"
    viewBox="0 0 40 40"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    aria-hidden="true"
    focusable="false"
  >
    <g stroke="currentColor" stroke-linecap="round" stroke-linejoin="round">
      <path class="brand-icon__link" d="M20 14V8M15 23L9.5 27M25 23L30.5 27" />
      <circle cx="20" cy="5.5" r="2.5" />
      <circle cx="7.25" cy="29" r="2.5" />
      <circle cx="32.75" cy="29" r="2.5" />
      <path d="M14.5 17.5L20 13.75L25.5 17.5V24L20 27.75L14.5 24V17.5Z" />
      <circle cx="20" cy="20.75" r="2.25" />
      <path class="brand-icon__signal" d="M16.25 12.5A6.25 6.25 0 0 1 23.75 12.5" />
      <path class="brand-icon__signal" d="M13.5 9.5A10.5 10.5 0 0 1 26.5 9.5" />
    </g>
  </svg>
</template>

<style scoped>
.brand-icon {
  width: 72%;
  height: 72%;
  overflow: visible;
  color: inherit;
  filter: drop-shadow(0 0 0.18rem currentColor);
}

.brand-icon g {
  stroke-width: 1.5;
  vector-effect: non-scaling-stroke;
}

.brand-icon__link,
.brand-icon__signal {
  opacity: 0.72;
}
</style>
