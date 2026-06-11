const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const distDir = path.join(projectRoot, "dist");
const stagingDir = path.join(projectRoot, ".html5-zip-tmp");
const zipPath = path.join(distDir, "padones-santa-fe.zip");
const excludedDirs = new Set(["resources", "test-resources"]);

if (!fs.existsSync(distDir)) {
  throw new Error(`Build output folder not found: ${distDir}`);
}

fs.rmSync(zipPath, { force: true });
fs.rmSync(stagingDir, { recursive: true, force: true });

function copyBuildOutput(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (entry.name === path.basename(zipPath)) {
      continue;
    }

    if (entry.isDirectory() && excludedDirs.has(entry.name)) {
      continue;
    }

    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(targetDir, entry.name);

    if (entry.isDirectory()) {
      copyBuildOutput(sourcePath, targetPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(sourcePath, targetPath);
    }
  }
}

copyBuildOutput(distDir, stagingDir);

const result =
  process.platform === "win32"
    ? spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Compress-Archive -Path '${path.join(stagingDir, "*")}' -DestinationPath '${zipPath}' -Force`,
        ],
        { stdio: "inherit" }
      )
    : spawnSync("zip", ["-r", zipPath, "."], {
        cwd: stagingDir,
        stdio: "inherit",
      });

fs.rmSync(stagingDir, { recursive: true, force: true });

if (result.status !== 0) {
  throw new Error("Could not create HTML5 application zip");
}

console.log(`Created ${path.relative(projectRoot, zipPath)}`);
