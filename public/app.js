const parts = await Promise.all([0,1,2,3].map(async (i) => (await fetch(`/.chunks/app.${i}.txt`)).text()));
const src = parts.join("");
const blob = new Blob([src], { type: "text/javascript" });
await import(URL.createObjectURL(blob));
