export const REFINE_MENU_BAR_ICON_ID = "refine-menu-bar";

// Refine/Assets.xcassets/MenuBarIcon.imageset/48.png, embedded so the plugin
// remains a self-contained main.js/styles.css/manifest.json installation.
const REFINE_MENU_BAR_ICON_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAACXBIWXMAAAsTAAALEwEAmpwYAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAOfSURBVHgB7ZlLSFVBGMf/11IrRCojQzFNI7PSoiyigiIiohYRtckeLlrksm1Ij10LFxG0iYgiLIIgDKJtD2wRkaS9EEINqRTtgYUQmtN/OEe8HWfmnjNnrlfCH/yZe8/MfDPfnDNnvpkDzDBDLBKwRAhRxuR3IpH4EriezeQEVUm1M/8GIsD6y5kUsN5zpAs2UkGNUF1UfiDvsviX21Q9tT+E3avUmF/vCNIFjV9P6uBx/9o5alSYuWCweT5QtgXpgsafJTV0nyoS4fjmO1oVsNegKPsI6YLGuwON1YloDFIJ31YZ1WfrQBbsGAz8v4VozKPK2cliprKjhYoy7xGC2bDjAVULe+ZST6gxqkRT5i6iwhHJp+pDlCvyH4N00QobWDGXeh2y7Hbqk3DPB+GtMXZIB6hQc0N4E7BbuOMhVYIIqDraS61COLZSZYjPS2oDV9+9VG+UiqpJ3CWNUW90lThKeUyuUBVwQ6XfbmRUd6CdKjdXw1mqkcqFG+SArIMFKgd+UjXmavhFfYQ3chlF5cALqipFvRx47/IcuGMXLJgUTgtvif9DLeSE+qGqxDJnZD51Cu4QpjajWRKin1phyF8iJsJel6xFRHTv+zZqB/TITYe8UwLu6OHot0eso3Wgj1qG1Fjv6BQ0wgKdAz1UNfTIkfoKt1gFljoHZCirXY15q+Wr9iDc8hSu4GSq9SfpghTl3gk3NMES3R2Qy7p8vlfCzDF4j1tcSuEajspnqiFEuS0iPgOUlROmsHmIOkTDq2FmJ+KziGplW5vgAhoqFt6Zj2RYBE4RksodFm4ZonYjLjRyLWC4RVFGbma+C/dIm2sQBxroDBjtC+QnhLf1SxcdYfuqmwN5gf+FNLov6b/cD7jazKioZnunYQsrX1SMyj0/r1LEJ0wgKE/x5qfqq+4ONCuuHaDBbUzrEJ8wMZRcRFMe8WgN+c9hMB6S8U8Bpo4Ohi3GENu0DrQprk1l5yU1HMjNpgImB+LvjNywx5RpcqAb0wPjhxHTHCjDRFCXSeT+PJtzQbn7094BVuhh8hiZZxYM50/G0ZXvfCavqDnIHAMczMW6TOMhLit2MjmJ6TOhJ5HyFJpO3GSynrqDzPAWruAjVaoJM9LJUVOfIn0j492Q56FT+ThdYpvNpgKRX5HCi9Wl0aUBG8L/Pa6spN8S+T1sNKmcPEYZgRfzBJFf/+XxfRMdGAYcOuAS4Z3DboT31XKcfnY61BfK/4K/G/E8iNXH49IAAAAASUVORK5CYII=";

export const REFINE_MENU_BAR_ICON_SVG = `
  <mask id="refine-menu-bar-icon-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="100" height="100" style="mask-type: alpha">
    <image href="data:image/png;base64,${REFINE_MENU_BAR_ICON_PNG}" x="0" y="0" width="100" height="100" />
  </mask>
  <rect x="0" y="0" width="100" height="100" fill="currentColor" mask="url(#refine-menu-bar-icon-mask)" />
`;
