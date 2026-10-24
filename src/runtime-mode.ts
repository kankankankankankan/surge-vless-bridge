import type { CliConfig } from './types/cli-config';

export const RUNTIME_MODE_CONFIRMATION_MESSAGE = '请先选择并确认运行引擎。';

export const assertRuntimeModeConfirmed = (config: Pick<CliConfig, 'runtimeModeConfirmed'>) => {
  if (!config.runtimeModeConfirmed) {
    throw new Error(RUNTIME_MODE_CONFIRMATION_MESSAGE);
  }
};
