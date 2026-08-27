// In a real project these imports would be from the installed package.
import '../../src/cypress/commands.js';
import { registerFailureCapture } from '../../src/cypress/failure-hook.js';

registerFailureCapture();
