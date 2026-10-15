<script setup>
defineProps({name:String});
const paths={
 home:'M3 10.5 12 3l9 7.5M5 9v11h5v-6h4v6h5V9',
 consoles:'M7 8h10c2.3 0 3.4 1.7 4 4l1 5c.4 2-1.7 3.2-3.1 1.8L16 16H8l-2.9 2.8C3.7 20.2 1.6 19 2 17l1-5c.6-2.3 1.7-4 4-4ZM7 10.5v5M4.5 13H9.5M16 11.5h.01M19 14h.01M9 4h6',
 search:'M10.5 3a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15ZM16 16l5 5M7.5 10.5a3 3 0 0 1 3-3',
 updates:'M20 8a8.5 8.5 0 0 0-14.5-3L3 8m0-5v5h5M4 16a8.5 8.5 0 0 0 14.5 3l2.5-3m0 5v-5h-5M12 8v8m-3-3 3 3 3-3',
 support:'M12 20.5 3.8 12.7C-1.1 7.8 5.6 1.4 10 5.9L12 8l2-2.1c4.4-4.5 11.1 1.9 6.2 6.8L12 20.5Z'
};
</script>
<template><svg class="menu-icon" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path :d="paths[name]"/></svg></template>
