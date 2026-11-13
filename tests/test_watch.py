import importlib.util
import io
import json
import unittest
import urllib.error
from pathlib import Path

spec = importlib.util.spec_from_file_location('watch', Path(__file__).parents[1] / 'scripts/watch.py')
watch = importlib.util.module_from_spec(spec)
spec.loader.exec_module(watch)
URL = 'https://test-only.example.chatgpt.site'


def state(**extra):
    return {'movies': [{'active': True}], 'cinemas': [{'id': '25769'}, {'id': '39869'}],
            'lastSuccess': 1000, 'schedulerHeartbeat': 1000, **extra}


class Response(io.BytesIO):
    status = 200
    headers = {'Content-Type': 'application/json'}


class Opener:
    def __init__(self, *responses):
        self.responses = iter(responses)
        self.requests = []

    def open(self, req, timeout):
        self.requests.append(req)
        result = next(self.responses)
        if isinstance(result, Exception):
            raise result
        return Response(json.dumps(result).encode())


class WatchTests(unittest.TestCase):
    def site(self, *responses):
        opener = Opener(*responses)
        return watch.Site(URL, 'test-secret', opener), opener

    def test_read_only_status_does_not_trigger_checks(self):
        site, opener = self.site(state())
        self.assertEqual(watch.run(site, 'status')['outcome'], 'status')
        self.assertEqual(len(opener.requests), 1)
        self.assertEqual(opener.requests[0].method, 'GET')

    def test_success_requires_both_cinemas_and_persisted_heartbeat(self):
        tick = {'checks': [{'sessions': 4}, {'sessions': 0}], 'newNotifications': 1}
        site, opener = self.site(state(), tick, state())
        report = watch.run(site, clock=lambda: 1000)
        self.assertEqual(report['outcome'], 'checked')
        self.assertEqual(report['notifications_queued'], 1)
        self.assertEqual(json.loads(opener.requests[1].data), {'source': 'github-actions'})
        self.assertEqual(opener.requests[1].get_header('Oai-sites-authorization'), 'Bearer test-secret')

    def test_failed_or_stale_readback_cannot_claim_success(self):
        for after in (state(lastSuccess=900), state(schedulerHeartbeat=None)):
            site, _ = self.site(state(), {'checks': [{'sessions': 1}, {'sessions': 2}]}, after)
            with self.assertRaises(watch.WatchError):
                watch.run(site, clock=lambda: 1000)

    def test_paused_state_never_ticks_or_resumes(self):
        site, opener = self.site(state(paused='manual pause'))
        self.assertEqual(watch.run(site)['outcome'], 'paused')
        self.assertEqual(len(opener.requests), 1)

    def test_busy_cooldown_and_new_pause_are_reported_as_skipped(self):
        for result in ({'busy': True}, {'cooldown': True}, {'paused': 'risk'}):
            site, opener = self.site(state(), result)
            self.assertNotEqual(watch.run(site)['outcome'], 'checked')
            self.assertEqual(len(opener.requests), 2)

    def test_tick_application_error_fails_without_echoing_remote_secrets(self):
        site, _ = self.site(state(), {'error': 'test-secret'})
        with self.assertRaises(watch.WatchError) as caught:
            watch.run(site)
        self.assertNotIn('test-secret', str(caught.exception))

    def test_login_redirect_does_not_forward_credential(self):
        self.assertIsNone(watch.NoRedirect().redirect_request(None, None, 302, '', {}, 'https://other.test'))
        site, opener = self.site(urllib.error.HTTPError(URL, 302, 'secret', {}, None))
        with self.assertRaises(watch.WatchError):
            site.request('/api/state')
        self.assertEqual(len(opener.requests), 1)

    def test_reject_untrusted_destinations_and_routes(self):
        for url in ('http://test.example.chatgpt.site', 'https://test.example.chatgpt.site.evil.test',
                    URL + '/other', URL + '?key=hidden', 'https://user@test.example.chatgpt.site'):
            with self.assertRaises(watch.WatchError):
                watch.Site(url, 'test-secret')
        site, _ = self.site()
        with self.assertRaises(watch.WatchError):
            site.request('//other.test')

    def test_configure_only_after_success_and_read_back(self):
        schedule = {'provider': 'github-actions', 'frequency': 'five_minutes',
                    'repository': 'test/new-repository', 'workflow': 'scheduled-watch.yml'}
        site, opener = self.site(state(), {'checks': [{'sessions': 1}, {'sessions': 1}]},
                                 state(), {'ok': True}, state(schedule=schedule))
        self.assertTrue(watch.run(site, 'configure', 'test/new-repository', lambda: 1000)['scheduler_recorded'])
        self.assertEqual(json.loads(opener.requests[3].data)['schedule'], schedule)


if __name__ == '__main__':
    unittest.main()
