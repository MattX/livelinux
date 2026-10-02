/* forker: fork N children (default 4) that sleep in a loop; parent waits. */
#include <stdio.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>

int main(int argc, char **argv)
{
	int n = argc > 1 ? atoi(argv[1]) : 4;
	int i;

	if (n < 0)
		n = 0;
	for (i = 0; i < n; i++) {
		pid_t pid = fork();
		if (pid < 0) {
			perror("fork");
			break;
		}
		if (pid == 0) {
			for (;;)
				sleep(1);
		}
		printf("forker: child %d pid %d\n", i, pid);
	}
	fflush(stdout);
	for (;;) {
		if (wait(NULL) < 0)
			break;
	}
	return 0;
}
