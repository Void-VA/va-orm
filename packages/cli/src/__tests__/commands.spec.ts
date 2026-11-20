// VA-ORM CLI Commands Spec

import { describe, it, expect } from 'bun:test';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { validateCommand } from '../commands/validate.command.js';
import { generateCommand } from '../commands/generate.command.js';
import { migrateCommand } from '../commands/migrate.command.js';

describe('CLI Commands', () => {
  describe('validateCommand', () => {
    it('should be a function', () => {
      expect(typeof validateCommand).toBe('function');
    });

    it('should accept options', () => {
      // Just test that the function accepts the correct parameters
      expect(validateCommand.length).toBe(1);
    });
  });

  describe('generateCommand', () => {
    it('should be a function', () => {
      expect(typeof generateCommand).toBe('function');
    });

    it('should accept options', () => {
      expect(generateCommand.length).toBe(1);
    });

    async function generateSql(datasourceProvider: string, provider?: string): Promise<string> {
      const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'va-generate-'));
      const schemaPath = path.join(dir, 'va.schema');
      const outputDir = path.join(dir, 'generated');
      await fs.writeFile(
        schemaPath,
        `datasource db { provider = "${datasourceProvider}" }\n` +
          `model Account {\n` +
          `  id    Int    @id @default(autoincrement())\n` +
          `  email String @unique\n` +
          `}\n`,
      );

      await generateCommand({ schema: schemaPath, output: outputDir, sql: true, provider });
      return fs.readFile(path.join(outputDir, 'schema.sql'), 'utf-8');
    }

    it('should default the SQL dialect to the schema datasource (mysql)', async () => {
      const sql = await generateSql('mysql');
      expect(sql).toContain('id INTEGER PRIMARY KEY AUTO_INCREMENT');
      expect(sql).not.toContain('DEFAULT AUTO_INCREMENT');
      expect(sql).not.toContain('GENERATED ALWAYS');
    });

    it('should default the SQL dialect to the schema datasource (sqlite)', async () => {
      const sql = await generateSql('sqlite');
      expect(sql).toContain('id INTEGER PRIMARY KEY AUTOINCREMENT');
      expect(sql).not.toContain('GENERATED ALWAYS');
    });

    it('should let --provider override the datasource dialect', async () => {
      const sql = await generateSql('mysql', 'postgres');
      expect(sql).toContain('id INTEGER PRIMARY KEY GENERATED ALWAYS AS IDENTITY');
      expect(sql).not.toContain('AUTO_INCREMENT');
    });
  });

  describe('migrateCommand', () => {
    it('should be a function', () => {
      expect(typeof migrateCommand).toBe('function');
    });

    it('should accept options', () => {
      expect(migrateCommand.length).toBe(1);
    });
  });
});
