/*
 * pipepair: two processes joined by a pair of pipes (for the fd graph).
 *
 * The parent writes "ping N" into one pipe; the child reads it on stdin and
 * answers "pong N" on stdout, which is the other pipe, as in a shell
 * pipeline. Each process prints its fd table (readlink of /proc/self/fd/N)
 * so the graph can be checked against what the guest reports.
 *
 *   pipepair [interval-ms]   ping-pong forever (default 1000 ms)
 *   pipepair -f              fill: the child never reads, so the parent fills
 *                            the ping pipe's ring (16 pages) and then blocks
 *                            in pipe_write
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MSG 16 /* fixed-size messages; writes <= PIPE_BUF are atomic */

static void show_fds(const char *who)
{
	char path[64], target[64];
	int fd;
	ssize_t n;

	for (fd = 0; fd < 16; fd++) {
		snprintf(path, sizeof(path), "/proc/self/fd/%d", fd);
		n = readlink(path, target, sizeof(target) - 1);
		if (n < 0)
			continue;
		target[n] = 0;
		fprintf(stderr, "pipepair: %s pid %d fd %d -> %s\n", who, getpid(), fd, target);
	}
}

static int read_full(int fd, char *buf, size_t len)
{
	size_t got = 0;
	ssize_t n;

	while (got < len) {
		n = read(fd, buf + got, len - got);
		if (n <= 0)
			return -1;
		got += n;
	}
	return 0;
}

int main(int argc, char **argv)
{
	int fill = argc > 1 && strcmp(argv[1], "-f") == 0;
	long ms = argc > 1 && !fill ? atol(argv[1]) : 1000;
	int ping[2], pong[2];
	char buf[MSG + 1];
	unsigned n;
	pid_t pid;

	if (pipe(ping) < 0 || pipe(pong) < 0) {
		perror("pipe");
		return 1;
	}
	pid = fork();
	if (pid < 0) {
		perror("fork");
		return 1;
	}
	if (pid == 0) {
		/* child: stdin = ping read end, stdout = pong write end */
		dup2(ping[0], 0);
		dup2(pong[1], 1);
		close(ping[0]);
		close(ping[1]);
		close(pong[0]);
		close(pong[1]);
		show_fds("child ");
		if (fill)
			for (;;)
				pause();
		for (;;) {
			if (read_full(0, buf, MSG) < 0)
				return 0;
			memcpy(buf, "pong", 4);
			if (write(1, buf, MSG) != MSG)
				return 0;
		}
	}

	/* parent keeps the ping write end and the pong read end */
	close(ping[0]);
	close(pong[1]);
	usleep(100000); /* let the child print its fds first */
	fprintf(stderr, "pipepair: parent pid %d, child pid %d\n", getpid(), pid);
	show_fds("parent");

	if (fill) {
		memset(buf, 'F', sizeof(buf));
		for (n = 0;; n++) {
			if (n % 256 == 0)
				fprintf(stderr, "pipepair: %u KiB queued in the ping pipe%s\n",
					n * MSG / 1024, n ? "" : " (blocks at 64 KiB)");
			if (write(ping[1], buf, MSG) != MSG) {
				perror("write");
				return 1;
			}
		}
	}

	for (n = 0;; n++) {
		snprintf(buf, sizeof(buf), "ping %010u\n", n);
		if (write(ping[1], buf, MSG) != MSG || read_full(pong[0], buf, MSG) < 0) {
			fprintf(stderr, "pipepair: child went away\n");
			return 1;
		}
		buf[MSG - 1] = 0;
		if (n < 3 || n % 60 == 0) /* keep the console usable */
			fprintf(stderr, "pipepair: %s\n", buf);
		usleep(ms * 1000);
	}
}
