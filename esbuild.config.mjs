import esbuild from "esbuild";
import process from "process";

const isProduction = process.argv.includes("production");

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view"],
  format: "cjs",
  target: "es2018",
  logLevel: "info",
  sourcemap: !isProduction,
  minify: isProduction,
  outfile: "main.js"
});

if (isProduction) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
  console.log("watching...");
}
