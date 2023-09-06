import fse from "fs-extra";
import { join } from "path";

// Copy sharp node_modules to the dist directory
fse.copySync(join(process.cwd(), "data"), join(process.cwd(), "dist", "data"), {
  dereference: true
});
