"""Exercise portable process-group waiting and cancellation without Docker or models."""
import os
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import shlex
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch
from pathlib import Path

from scripts.agent.harbor.cancellable_environment import execution_commands, gateway_health


class GatewayBarrierTests(unittest.TestCase):
    def test_custom_gateway_uses_attempt_credential_without_legacy_endpoint(self):
        observed = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                observed.append((self.path, self.headers.get('Authorization')))
                self.send_response(200)
                self.end_headers()
                self.wfile.write(json.dumps({'activeUpstreamRequests': 0, 'scheduler': {'queued': 0}}).encode())
            def log_message(self, *_):
                pass
        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server, tempfile.TemporaryDirectory() as directory:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            token = Path(directory) / 'attempt.token'
            token.write_text('fixture-signed-attempt')
            try:
                with patch.dict(os.environ, {'SCRIPTACT_BENCH_TOKEN_FILE': str(token),
                    'SCRIPTACT_GATEWAY_HEALTH_URL': f'http://127.0.0.1:{server.server_port}/health'}):
                    self.assertEqual(gateway_health()['activeUpstreamRequests'], 0)
                self.assertEqual(observed, [('/health', 'Bearer fixture-signed-attempt')])
            finally:
                server.shutdown()
                thread.join(timeout=2)


class PortableExecutionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='harbor-portable-cancel-')
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.group = self.root / 'execution'
        # POSIX session semantics are real; only the CLI's supported flags differ.
        launcher = self.root / 'setsid'
        launcher.write_text(f'''#!{sys.executable}
import os,sys
args=sys.argv[1:]
if args and args[0].startswith('-'):
    sys.stderr.write('setsid: unrecognized option\\n')
    sys.exit(1)
if os.getpid()==os.getpgrp():
    if os.fork():sys.exit(0)
os.setsid()
os.execvp(args[0],args)
''')
        launcher.chmod(0o755)
        self.environment = {**os.environ, 'PATH': str(self.root) + os.pathsep + os.environ['PATH']}

    def execute(self, command):
        return subprocess.run(['bash', '-c', command], env=self.environment,
                              capture_output=True, text=True, timeout=8, start_new_session=True)

    def test_foreground_wait_preserves_output_exit_status_and_session_identity(self):
        program = "import os,time;time.sleep(.08);print(os.getpid()==os.getpgrp()==os.getsid(0),flush=True)"
        # $$ denotes the session-owning body; Python is its foreground child.
        command = f"printf '%s ' before; {shlex.quote(sys.executable)} -c {shlex.quote(program)}; printf after; exit 7"
        wrapped, _ = execution_commands(command, str(self.group))
        result = self.execute(wrapped)
        self.assertEqual(result.returncode, 7, result.stderr)
        self.assertEqual(result.stdout, 'before False\nafter')
        self.assertFalse((self.group / 'pid').exists())

    def test_precancelled_command_never_runs(self):
        self.group.mkdir()
        (self.group / 'cancelled').touch()
        touched = self.root / 'should-not-exist'
        wrapped, _ = execution_commands('touch ' + shlex.quote(str(touched)), str(self.group))
        result = self.execute(wrapped)
        self.assertEqual(result.returncode, 125, result.stderr)
        self.assertFalse(touched.exists())
        self.assertFalse((self.group / 'pid').exists(), 'cancelled startup must not leave a stale process-group identity')

    def test_pipeline_and_shell_quoting_are_preserved(self):
        wrapped, _ = execution_commands("printf '%s\\n' 'a b' | tr 'a-z' 'A-Z'", str(self.group))
        result = self.execute(wrapped)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, 'A B\n')

    def test_cleanup_kills_term_resistant_descendant_but_preserves_other_session(self):
        heartbeat = self.root / 'heartbeat'
        other_heartbeat = self.root / 'other-heartbeat'
        program = "import signal,time,sys;signal.signal(signal.SIGTERM,signal.SIG_IGN);f=open(sys.argv[1],'a');\nwhile True:f.write('x');f.flush();time.sleep(.02)"
        child = shlex.quote(sys.executable) + ' -c ' + shlex.quote(program) + ' ' + shlex.quote(str(heartbeat))
        wrapped, cleanup = execution_commands(child, str(self.group))
        process = subprocess.Popen(['bash','-c',wrapped], env=self.environment, stdout=subprocess.DEVNULL,
                                   stderr=subprocess.DEVNULL, start_new_session=True)
        other = subprocess.Popen([sys.executable,'-c',program,str(other_heartbeat)],
                                 stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True)
        try:
            deadline = time.monotonic()+3
            while time.monotonic()<deadline and not (heartbeat.exists() and other_heartbeat.exists() and (self.group/'pid').exists()):
                time.sleep(.02)
            self.assertTrue(heartbeat.exists(),'wrapped command did not start')
            leader = int((self.group/'pid').read_text())
            self.assertEqual(os.getpgid(leader),leader)
            self.assertEqual(os.getsid(leader),leader)
            result = self.execute(cleanup)
            self.assertEqual(result.returncode,0,result.stderr)
            process.wait(timeout=3)
            size = heartbeat.stat().st_size
            other_size = other_heartbeat.stat().st_size
            time.sleep(.12)
            self.assertEqual(heartbeat.stat().st_size,size)
            self.assertGreater(other_heartbeat.stat().st_size,other_size)
        finally:
            if (self.group/'pid').exists():
                try:os.killpg(int((self.group/'pid').read_text()),signal.SIGKILL)
                except ProcessLookupError:pass
            for p in (process,other):
                if p.poll() is None:
                    try:os.killpg(p.pid,signal.SIGKILL)
                    except ProcessLookupError:pass
                p.wait(timeout=3)


if __name__=='__main__':unittest.main()
