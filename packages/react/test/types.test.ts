// @vitest-environment node
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

describe('the declared types', () => {
  it('declare the provider as returning a JSX element, which @types/react 18 accepts as a component', () => {
    const config = ts.getParsedCommandLineOfConfigFile(here('../tsconfig.json'), undefined, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    const program = ts.createProgram([here('../src/index.ts')], config?.options ?? {});
    const checker = program.getTypeChecker();
    const index = program.getSourceFile(here('../src/index.ts'));
    const exported = checker.getExportsOfModule(checker.getSymbolAtLocation(index!)!).find((symbol) => symbol.name === 'TarjimProvider');
    const signature = checker.getTypeOfSymbol(exported!).getCallSignatures()[0];

    expect(checker.typeToString(signature!.getReturnType(), undefined, ts.TypeFormatFlags.UseFullyQualifiedType)).toMatch(/JSX\.Element$/);
  });
});
