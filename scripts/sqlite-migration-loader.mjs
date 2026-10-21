import {createRequire} from 'node:module';

/** Legacy-only dependency, deliberately outside the server dependency tree. */
export function loadLegacySqlite(packageFile=new URL('../tools/sqlite-migration/package.json',import.meta.url)) {
  try{return createRequire(packageFile)('./node_modules/better-sqlite3');}
  catch(error){
    if(error.code==='MODULE_NOT_FOUND'&&error.message.includes("'./node_modules/better-sqlite3'")){
      throw Object.assign(new Error('SQLite migration is optional. Install its dependencies first: npm ci --prefix tools/sqlite-migration'),{code:'sqlite_migration_dependency_missing'});
    }
    throw error;
  }
}
